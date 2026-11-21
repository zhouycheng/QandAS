package qanda.backend.platform.bootstrap

import org.springframework.jdbc.datasource.DriverManagerDataSource

object ProductionSchema {
    fun run() {
        val url=System.getenv("BACKEND_DB_URL") ?: error("BACKEND_DB_URL is required")
        require(url.matches(Regex("jdbc:postgresql://[^/]+/qanda_backend(?:\\?.*)?"))) { "A dedicated qanda_backend database is required" }
        val source=DriverManagerDataSource(url,System.getenv("BACKEND_DB_USER") ?: "qanda_backend",System.getenv("BACKEND_DB_PASSWORD") ?: error("BACKEND_DB_PASSWORD is required"))
        source.connection.use { connection ->
            connection.createStatement().use { sql ->
                sql.execute("SELECT pg_advisory_lock(724680130)")
                val empty = sql.executeQuery("SELECT NOT EXISTS (SELECT FROM information_schema.tables WHERE table_schema='public')").use { it.next(); it.getBoolean(1) }
                if (empty) DatabaseCommands.initialize(source)
                sql.execute("SET lock_timeout='5s'")
                verifyReleasedColumns(sql)
                sql.execute("CREATE TABLE IF NOT EXISTS schema_migration (id text PRIMARY KEY, revision text, completed_at timestamptz NOT NULL DEFAULT now())")
                fun migrate(id: String, verify: String, action: () -> Unit) {
                    val done = connection.prepareStatement("SELECT 1 FROM schema_migration WHERE id=?").use {
                        it.setString(1,id); it.executeQuery().use { rows -> rows.next() }
                    }
                    if (!done) action()
                    sql.executeQuery(verify).close()
                    if (done) return
                    connection.prepareStatement("INSERT INTO schema_migration(id,revision) VALUES (?,?)").use {
                        it.setString(1,id); it.setString(2,System.getenv("BACKEND_REVISION")); it.executeUpdate()
                    }
                }
                sql.execute(org.springframework.core.io.ClassPathResource("db/admin-password-policy.sql").getContentAsString(Charsets.UTF_8))
                migrate("001-legacy-baseline", """SELECT q.portable_id,s.writer_epoch,f.read_version,c.read_version,i.confirmed_at
                    FROM question q,practice_sync_state s,question_feedback f,course_request c,practice_item i LIMIT 0""") {
                    sql.execute("ALTER TABLE practice_item ADD COLUMN IF NOT EXISTS confirmed_at timestamptz")
                    for (table in listOf("question_feedback","course_request"))
                        sql.execute("ALTER TABLE $table ADD COLUMN IF NOT EXISTS read_version bigint NOT NULL DEFAULT 0 CHECK(read_version BETWEEN 0 AND version)")
                    upgradeBankPackages(connection)
                    sql.execute("ALTER TABLE question ALTER COLUMN portable_id SET NOT NULL")
                    for (name in listOf("user-settings","practice-writer"))
                        sql.execute(org.springframework.core.io.ClassPathResource("db/$name.sql").getContentAsString(Charsets.UTF_8))
                }
                migrate("002-compatibility-observation", """SELECT inventory.practice_revisions,u.hits,c.observed,r.manifest
                    FROM compatibility_inventory inventory,compatibility_usage u,compatibility_coverage c,compatibility_release r LIMIT 0""") {
                    sql.execute(org.springframework.core.io.ClassPathResource("db/compatibility.sql").getContentAsString(Charsets.UTF_8))
                }
                migrate("003-bank-deletion", "SELECT b.deleted_at,s.bank_name,i.issued_version,i.issued_status,i.issued_chapter_id FROM question_bank b,practice_session s,practice_item i LIMIT 0") {
                    sql.execute(org.springframework.core.io.ClassPathResource("db/bank-deletion.sql").getContentAsString(Charsets.UTF_8))
                }
                migrate("004-subject-category", "SELECT subject_id,subject_matches_category(subject_id,NULL,NULL,NULL) FROM subject_category LIMIT 0") {
                    sql.execute(org.springframework.core.io.ClassPathResource("db/subject-category.sql").getContentAsString(Charsets.UTF_8))
                }
                System.getenv("BACKEND_PREVIOUS_REVISION")?.takeIf { it.matches(Regex("[0-9a-f]{40}")) }?.let { previous ->
                    connection.prepareStatement("INSERT INTO compatibility_release(release,manifest) VALUES (?, '[]') ON CONFLICT DO NOTHING").use {
                        it.setString(1,previous); it.executeUpdate()
                    }
                }
            }
        }
    }

    private fun verifyReleasedColumns(sql: java.sql.Statement) {
        // Column signatures from the deployed baseline. Later additive columns are compatible.
        val actual = sql.executeQuery("""SELECT c.relname, a.attname,
            a.atttypid::regtype::text || ':' || a.atttypmod || ':' || a.attnotnull AS signature
            FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
            WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped""").use { rows ->
            buildMap { while (rows.next()) put("${rows.getString(1)}.${rows.getString(2)}", rows.getString(3)) }
        }
        val repairable = setOf("practice_item.confirmed_at", "question_feedback.read_version", "course_request.read_version")
        val differences = mutableListOf<String>()
        org.springframework.core.io.ClassPathResource("db/baseline-09715715.txt").inputStream.bufferedReader().useLines { lines ->
            lines.forEach { line ->
                val table = line.substringBefore(' ')
                for (column in line.substringAfter(' ').split('|')) {
                    val key = "$table.${column.substringBefore(':')}"
                    val expected = column.substringAfter(':')
                    val observed = actual[key]
                    if (observed != expected && !(observed == null && key in repairable))
                        differences.add("$key 预期 $expected，实际 ${observed ?: "缺失"}")
                }
            }
        }
        check(differences.isEmpty()) { "无法识别数据库基线：" + differences.joinToString() }
    }

    internal fun upgradeBankPackages(connection: java.sql.Connection) {
        check(connection.autoCommit)
        connection.createStatement().use { sql ->
            // Adding a volatile default and backfilling in the same ALTER would rewrite the live question table under an exclusive lock.
            sql.execute("ALTER TABLE question ADD COLUMN IF NOT EXISTS portable_id uuid")
            sql.execute("ALTER TABLE question ALTER COLUMN portable_id SET DEFAULT gen_random_uuid()")
        }
        val batch="""WITH ids AS (SELECT id FROM question WHERE portable_id IS NULL AND (?::uuid IS NULL OR id>?::uuid) ORDER BY id LIMIT 500),
            updated AS (UPDATE question q SET portable_id=gen_random_uuid() FROM ids WHERE q.id=ids.id AND q.portable_id IS NULL RETURNING q.id)
            SELECT id FROM updated ORDER BY id DESC LIMIT 1"""
        connection.prepareStatement(batch).use { update ->
            var cursor: java.util.UUID?=null
            while(true) {
                update.setObject(1,cursor)
                update.setObject(2,cursor)
                cursor=update.executeQuery().use { rows -> if(rows.next()) rows.getObject(1,java.util.UUID::class.java) else null } ?: break
            }
        }
        val ddl=org.springframework.core.io.ClassPathResource("db/bank-package.sql").getContentAsString(Charsets.UTF_8)
        // Commit each DDL separately so ordinary reads remain available during index creation.
        connection.createStatement().use { sql -> ddl.split(';').filter { it.isNotBlank() }.forEach { sql.execute(it) } }
    }
}
