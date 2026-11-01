package qanda.backend.identity

import org.springframework.stereotype.Service
import qanda.backend.admin.AdminAccountMapper
import qanda.backend.identity.api.AccountDirectory
import java.util.UUID

@Service
class AccountDirectoryService(private val users: UserAccountMapper,private val admins: AdminAccountMapper): AccountDirectory {
    override fun exists(id: UUID)=users.selectById(id)!=null
    override fun activeAdmin(id: UUID)=admins.selectById(id)?.status=="ACTIVE"
}
