package qanda.backend.platform.security

import org.springframework.stereotype.Service
import qanda.backend.platform.persistence.SystemMapper

@Service
class TransactionLocks(private val sql: SystemMapper) {
    fun lock(scope: String) { sql.lock(scope) }
}
