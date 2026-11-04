package qanda.backend.platform.security

import org.springframework.stereotype.Service
import qanda.backend.platform.persistence.SystemMapper

@Service
class TransactionLocks(private val sql: SystemMapper) {
    fun lock(scope: String) { sql.lock(scope) }
    fun identityAvailable(scope: String) {
        // Account writes already hold the user lock; never wait on a login holding the identity lock.
        if(!sql.tryLock(scope)) qanda.backend.platform.http.conflict("IDENTITY_BUSY","身份正在验证，请稍后重试")
    }
}
