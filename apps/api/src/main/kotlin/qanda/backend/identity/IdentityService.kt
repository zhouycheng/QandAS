package qanda.backend.identity

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import qanda.backend.identity.api.WechatCodeExchange
import qanda.backend.platform.http.MutationResult
import qanda.backend.platform.http.requireVersion
import qanda.backend.platform.http.missing
import qanda.backend.platform.security.Actor
import qanda.backend.platform.security.LoginAttempts
import qanda.backend.platform.events.ActivityEvents
import java.time.Instant
import java.time.Clock
import java.util.Locale
import java.util.UUID

@Service
@Transactional
class IdentityService(private val users: UserAccountMapper,private val bindings: UserWechatMapper,
                      private val sessionRows: UserSessionMapper,private val challengeRows: EmailChallengeMapper,private val sql: IdentityMapper,
                      private val crypto: IdentityCrypto,private val challenges: ChallengeService,private val wechat: WechatCodeExchange,
                      private val locks: qanda.backend.platform.security.TransactionLocks,private val attempts: LoginAttempts,
                      private val clock: Clock,private val activity: ActivityEvents,private val testAccounts: TestAccountMapper) {
    fun view(id: UUID): UserView {
        val user=users.selectById(id) ?: missing()
        val bound=bindings.selectCount(QueryWrapper<UserWechat>().eq("user_id",id))>0
        return UserView(id,user.accountCode,user.nickname,user.email,bound,user.status,user.version,user.createdAt,user.avatar,sql.testAccountAccess(id)!=null)
    }
    fun login(input: LoginInput): TokenView {
        val address=email(input.email);val scope="test:${address.key}"
        if(attempts.blocked(scope)) unauthenticated("尝试次数过多，请稍后再试")
        val user=sql.userByEmail(address.key)
        val account=user?.let { sql.testAccountAccess(it.id!!) }
        val hash=account?.let { testAccounts.loginCodeHash(user!!.id!!) }
        if(!crypto.verifyTestLoginCode(input.password,hash) || user?.status!="ACTIVE" || account==null || !isTestEmail(address.key)) {
            attempts.failure(scope,5,30,true);unauthenticated("测试账号或登录码不正确")
        }
        checkTestAccount(account,clock.instant());attempts.clear(scope)
        return issueSession(user!!,input.deviceId,"TEST")
    }
    fun emailCodeLogin(input: EmailCodeLoginInput): TokenView {
        val row=challengeRows.selectById(input.challengeId) ?: invalidProof()
        if(row.purpose!="LOGIN" || isTestEmail(row.emailKey)) invalidProof()
        locks.lock("email:${row.emailKey}")
        sql.userByEmail(row.emailKey)?.let { sql.lockUser(it.id!!) ?: unauthenticated() }
        val proof=challenges.consume(input.challengeId,"LOGIN",row.userId)
        var user=sql.userByEmail(proof.emailKey)
        if(row.userId!=null && user?.id!=row.userId) invalidProof()
        if(user==null) {
            user=newUser("Q友").apply { email=proof.email;emailKey=proof.emailKey }
            users.insert(user)
        }
        if(user.status!="ACTIVE" || sql.testAccountAccess(user.id!!)!=null) invalidProof()
        return issueSession(user,input.deviceId,"EMAIL")
    }
    fun wechatLogin(input: WechatLoginInput): TokenView {
        val identity=wechat.exchange(input.code)
        locks.lock("wechat:${identity.appId}:${identity.openId}")
        val binding=sql.wechat(identity.appId,identity.openId)
        val user=if(binding!=null) users.selectById(binding.userId) ?: unauthenticated() else {
            val created=newUser("Q友");users.insert(created)
            bindings.insert(UserWechat().apply { id=UUID.randomUUID();userId=created.id;appId=identity.appId;openId=identity.openId;unionId=identity.unionId })
            created
        }
        if(user.status!="ACTIVE") unauthenticated()
        return issueSession(user,input.deviceId,"WECHAT")
    }
    private fun newUser(display: String)=UserAccount().apply { id=UUID.randomUUID();accountCode=crypto.accountCode();nickname=display;createdAt=clock.instant();updatedAt=createdAt }
    private fun issueSession(user: UserAccount,device: UUID,method: String): TokenView {
        val current=sql.lockUser(user.id!!) ?: unauthenticated()
        if(current.status!="ACTIVE" || current.credentialVersion!=user.credentialVersion) unauthenticated()
        val testAccess=sql.testAccountAccess(user.id!!);checkTestAccount(testAccess,clock.instant())
        val token="u_"+crypto.randomToken();val row=UserSession().apply { id=UUID.randomUUID();userId=user.id;tokenDigest=crypto.tokenDigest(token)
            credentialVersion=user.credentialVersion;deviceId=device;authMethod=method;issuedAt=clock.instant();lastSeenAt=issuedAt;expiresAt=minOf(issuedAt.plusSeconds(30*86400L),testAccess?.expiresAt ?: Instant.MAX) }
        sessionRows.insert(row);activity.record(user.id!!)
        return TokenView(token,row.id!!,row.expiresAt)
    }
    fun updateProfile(actor: Actor,input: ProfileInput): MutationResult {
        val user=sql.lockUser(actor.id) ?: unauthenticated();requireVersion(input.expectedVersion,user.version)
        user.nickname=nickname(input.nickname)
        input.avatar?.let { user.avatar=profileAvatar(it) }
        user.version++;user.updatedAt=clock.instant();users.updateById(user)
        return MutationResult(actor.id,user.version)
    }
    fun updateAdminProfile(id: UUID,input: AdminProfileInput): MutationResult {
        val user=sql.lockUser(id) ?: missing();requireVersion(input.expectedVersion,user.version)
        if(sql.testAccountAccess(id)!=null && (input.email!=user.email || input.accountCode!=user.accountCode)) fixedTestCredentials()
        val accountCode=input.accountCode.trim().uppercase(Locale.ROOT).also { if(!it.matches(Regex("[A-Z0-9_-]{2,12}"))) invalid("accountCode") }
        if(users.selectCount(QueryWrapper<UserAccount>().eq("account_code",accountCode).ne("id",id))>0) conflict("ACCOUNT_CODE_UNAVAILABLE","账号已被使用")
        val address=input.email?.trim()?.takeIf { it.isNotEmpty() }?.let { email(it) }
        if(address!=null && isTestEmail(address.key) && sql.testAccountAccess(id)==null) fixedTestCredentials()
        if(address!=null && sql.userByEmail(address.key)?.id?.let { it!=id }==true) conflict("EMAIL_UNAVAILABLE","该邮箱已被其他账号使用")
        if(address==null && bindings.selectCount(QueryWrapper<UserWechat>().eq("user_id",id))==0L) qanda.backend.platform.http.invalid("email","LOGIN_IDENTITY_REQUIRED","账号至少需要保留一种登录方式")
        val emailChanged=user.emailKey!=address?.key
        user.accountCode=accountCode;user.nickname=nickname(input.nickname);user.email=address?.display;user.emailKey=address?.key
        user.version++
        if(emailChanged) { user.credentialVersion++;sql.revokeUserSessions(id) }
        user.updatedAt=clock.instant()
        sql.updateAdminUser(id,user.accountCode,user.nickname,user.email,user.emailKey,user.version,user.credentialVersion,user.updatedAt)
        return MutationResult(id,user.version)
    }
    fun changeEmail(actor: Actor,input: EmailInput): MutationResult {
        if(sql.testAccountAccess(actor.id)!=null) fixedTestCredentials()
        val user=sql.lockUser(actor.id) ?: unauthenticated();requireVersion(input.expectedVersion,user.version)
        if(user.email!=null) challenges.consume(input.oldChallengeId ?: invalid("oldChallengeId"),"CHANGE_EMAIL_OLD",actor.id)
        val proof=challenges.consume(input.newChallengeId,if(user.email==null) "BIND_EMAIL" else "CHANGE_EMAIL_NEW",actor.id)
        if(sql.userByEmail(proof.emailKey)!=null) conflict("EMAIL_UNAVAILABLE","邮箱暂不可使用")
        locks.identityAvailable("email:${proof.emailKey}")
        if(sql.userByEmail(proof.emailKey)!=null) conflict("EMAIL_UNAVAILABLE","邮箱暂不可使用")
        sql.updateCredentials(actor.id,proof.email,proof.emailKey);sql.revokeUserSessions(actor.id)
        return MutationResult(actor.id,user.version+1)
    }
    fun bindWechat(actor: Actor,input: WechatBindingInput): MutationResult {
        if(sql.testAccountAccess(actor.id)!=null) fixedTestCredentials()
        val user=sql.lockUser(actor.id) ?: unauthenticated();requireVersion(input.expectedVersion,user.version)
        val identity=wechat.exchange(input.code)
        locks.identityAvailable("wechat:${identity.appId}:${identity.openId}")
        val existing=sql.wechat(identity.appId,identity.openId)
        if(existing?.userId==actor.id) {
            return MutationResult(actor.id,user.version)
        }
        if(existing!=null) conflict("WECHAT_ALREADY_BOUND","此微信已绑定其他账号，请使用原账号登录")
        if(bindings.selectCount(QueryWrapper<UserWechat>().eq("user_id",actor.id).eq("app_id",identity.appId))>0) conflict("WECHAT_ALREADY_BOUND","当前账号已绑定微信")
        try {
            bindings.insert(UserWechat().apply { id=UUID.randomUUID();userId=actor.id;appId=identity.appId;openId=identity.openId;unionId=identity.unionId })
        } catch(_: org.springframework.dao.DuplicateKeyException) { conflict("WECHAT_ALREADY_BOUND","此微信已被绑定，请刷新账号状态") }
        user.version++;users.updateById(user);return MutationResult(actor.id,user.version)
    }
    fun heartbeat(actor: Actor): HeartbeatView {
        val now=clock.instant()
        if(sql.touchForeground(actor.sessionId,actor.id,now)!=1) unauthenticated()
        activity.record(actor.id)
        return HeartbeatView(now,now.plusSeconds(120))
    }
    fun revoke(actor: Actor,id: UUID): MutationResult {
        val row=sql.lockUserSession(id) ?: missing();if(row.userId!=actor.id) missing()
        row.revokedAt=clock.instant();sessionRows.updateById(row);return MutationResult(id,1)
    }
}
