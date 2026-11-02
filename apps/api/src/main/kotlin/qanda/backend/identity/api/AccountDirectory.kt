package qanda.backend.identity.api

import java.util.UUID

interface AccountDirectory {
    fun exists(id: UUID): Boolean
    fun activeAdmin(id: UUID): Boolean
}
