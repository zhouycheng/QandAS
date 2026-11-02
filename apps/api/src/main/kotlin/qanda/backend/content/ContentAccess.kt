package qanda.backend.content

import org.springframework.stereotype.Component
import qanda.backend.platform.security.Actor
import qanda.backend.platform.http.*

@Component
class ContentAccess(private val sql: ContentQueries,private val banks: QuestionBankMapper) {
    fun bank(actor: Actor?,id: java.util.UUID,write: Boolean=false): QuestionBank {
        if(actor==null || actor.kind=="USER") {
            if(write) forbidden()
            return sql.bank(id,actor?.id) ?: missing()
        }
        if(actor.kind!="ADMIN" || actor.role!="SUPER_ADMIN") forbidden()
        val bank=(if(write) sql.lockBank(id) else banks.selectById(id)) ?: missing()
        return bank
    }
}
