package qanda.backend.platform.bootstrap

import org.springframework.jdbc.datasource.DriverManagerDataSource

object ProductionSchema {
    fun run() {
        val url=System.getenv("BACKEND_DB_URL") ?: error("BACKEND_DB_URL is required")
        require(url.matches(Regex("jdbc:postgresql://[^/]+/qanda_backend(?:\\?.*)?"))) { "A dedicated qanda_backend database is required" }
        val source=DriverManagerDataSource(url,System.getenv("BACKEND_DB_USER") ?: "qanda_backend",System.getenv("BACKEND_DB_PASSWORD") ?: error("BACKEND_DB_PASSWORD is required"))
        source.connection.use { connection ->
            connection.createStatement().use { statement ->
                statement.executeQuery("SELECT to_regclass('public.practice_result') IS NOT NULL").use { row ->
                    row.next()
                    if(row.getBoolean(1)) {
                        statement.executeQuery("SELECT result_source FROM practice_result WHERE false").close()
                        statement.executeQuery("SELECT NOT attnotnull FROM pg_attribute WHERE attrelid='sync_command'::regclass AND attname='payload_json'").use { payload ->
                            check(payload.next() && payload.getBoolean(1)) { "数据库结构未就绪，请使用当前空库初始化流程" }
                        }
                        return
                    }
                }
            }
        }
        DatabaseCommands.initialize(source)
    }
}
