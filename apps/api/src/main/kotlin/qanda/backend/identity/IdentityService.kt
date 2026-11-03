package qanda.backend.identity

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import qanda.backend.catalog.api.CatalogDirectory
import qanda.backend.identity.api.WechatCodeExchange
import qanda.backend.platform.http.MutationResult
import qanda.backend.platform.http.requireVersion
import qanda.backend.platform.http.missing
import qanda.backend.platform.security.Actor
import qanda.backend.platform.security.LoginAttempts
import qanda.backend.platform.events.ActivityEvents
import java.time.Instant
import java.time.Clock
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale
import java.util.UUID

@Service
@Transactional
class IdentityService(private val users: UserAccountMapper,private val profiles: UserProfileMapper,private val bindings: UserWechatMapper,
                      private val sessionRows: UserSessionMapper,private val tickets: WechatTicketMapper,private val challengeRows: EmailChallengeMapper,private val sql: IdentityMapper,
                      private val crypto: IdentityCrypto,private val challenges: ChallengeService,private val wechat: WechatCodeExchange,
                      private val directory: CatalogDirectory,private val attempts: LoginAttempts,
                      private val clock: Clock,private val activity: ActivityEvents) {
    fun view(id: UUID): UserView {
        val user=users.selectById(id) ?: missing();val profile=profiles.selectById(id)
        val college=profile?.majorId?.let { directory.major(it)?.collegeId } ?: profile?.collegeId
        val today=LocalDate.now(clock.withZone(ZoneId.of("Asia/Shanghai")))
        val grade=AcademicGrade.current(profile?.grade,profile?.gradeAcademicYear,today)
        val binding=bindings.selectList(QueryWrapper<UserWechat>().eq("user_id",id).orderByDesc("created_at").orderByAsc("id").last("LIMIT 1")).firstOrNull()
        return UserView(id,user.accountCode,user.nickname,user.email,binding!=null,
            college,profile?.majorId,grade,user.status,user.version,user.createdAt,college?.let { directory.college(it)?.name },profile?.majorId?.let { directory.major(it)?.name },
            AcademicGrade.academicYear(today),college!=null && profile?.majorId!=null && grade!=null,user.passwordHash!=null,user.avatar,user.profileSetupSeen || college!=null && profile?.majorId!=null && grade!=null,sql.testAccountAccess(id)!=null)
    }
    fun acknowledgeProfileSetup(actor: Actor): MutationResult {
        val user=sql.lockUser(actor.id) ?: unauthenticated()
        sql.markProfileSetupSeen(actor.id)
        return MutationResult(actor.id,user.version)
    }
    fun register(input: RegistrationInput): MutationResult {
        val password=crypto.prepareStudentPassword(input.password);val display=nickname(input.nickname)
        val proof=challenges.consume(input.challengeId,"REGISTER",null)
        if(sql.userByEmail(proof.emailKey)!=null) conflict("EMAIL_UNAVAILABLE","该邮箱暂不可注册")
        val user=newUser(display).apply { email=proof.email;emailKey=proof.emailKey;passwordHash=password.encoded }
        users.insert(user);profiles.insert(UserProfile().apply { userId=user.id })
        return MutationResult(user.id!!,user.version)
    }
    fun login(input: LoginInput): TokenView {
        val address=email(input.email)
        val scope="student:${address.key}";if(attempts.blocked(scope)) unauthenticated("尝试次数过多，请稍后再试")
        val user=sql.userByEmail(address.key)
        if(!crypto.verifyStudentPassword(input.password,user?.passwordHash) || user?.status!="ACTIVE") {
            attempts.failure(scope,5,30,true);unauthenticated("邮箱或密码不正确，请检查后重试")
        }
        attempts.clear(scope)
        return issueSession(user!!,input.deviceId)
    }
    fun emailCodeLogin(input: EmailCodeLoginInput): TokenView {
        val row=challengeRows.selectById(input.challengeId) ?: invalidProof()
        if(row.purpose!="LOGIN" || row.userId==null) invalidProof()
        val user=users.selectById(row.userId) ?: invalidProof()
        val proof=challenges.consume(input.challengeId,"LOGIN",user.id)
        if(user.emailKey!=proof.emailKey || user.status!="ACTIVE") invalidProof()
        return issueSession(user,input.deviceId)
    }
    fun wechatLogin(input: WechatLoginInput): WechatLoginView {
        val identity=wechat.exchange(input.code);val binding=sql.wechat(identity.appId,identity.openId)
        if(binding!=null) {
            val user=users.selectById(binding.userId) ?: unauthenticated();if(user.status!="ACTIVE") unauthenticated()
            return WechatLoginView(session=issueSession(user,input.deviceId))
        }
        val token=crypto.randomToken();tickets.insert(WechatTicket().apply { id=UUID.randomUUID();tokenDigest=crypto.tokenDigest(token)
            appId=identity.appId;openId=identity.openId;unionId=identity.unionId;expiresAt=clock.instant().plusSeconds(600) })
        return WechatLoginView(registrationToken=token)
    }
    fun registerWechat(input: WechatRegistrationInput): MutationResult {
        token(input.registrationToken);val display=nickname(input.nickname)
        val ticket=sql.lockTicket(crypto.tokenDigest(input.registrationToken)) ?: invalidProof()
        if(ticket.consumedAt!=null || !ticket.expiresAt.isAfter(clock.instant())) invalidProof()
        val user=newUser(display);users.insert(user);profiles.insert(UserProfile().apply { userId=user.id })
        bindings.insert(UserWechat().apply { id=UUID.randomUUID();userId=user.id;appId=ticket.appId;openId=ticket.openId;unionId=ticket.unionId })
        sql.consumeTicket(ticket.id!!)
        return MutationResult(user.id!!,1)
    }
    private fun newUser(display: String)=UserAccount().apply { id=UUID.randomUUID();accountCode=crypto.accountCode();nickname=display;createdAt=clock.instant();updatedAt=createdAt }
    private fun issueSession(user: UserAccount,device: UUID): TokenView {
        val current=sql.lockUser(user.id!!) ?: unauthenticated()
        if(current.status!="ACTIVE" || current.credentialVersion!=user.credentialVersion) unauthenticated()
        val testAccess=sql.testAccountAccess(user.id!!);checkTestAccount(testAccess,clock.instant())
        val token="u_"+crypto.randomToken();val row=UserSession().apply { id=UUID.randomUUID();userId=user.id;tokenDigest=crypto.tokenDigest(token)
            credentialVersion=user.credentialVersion;deviceId=device;issuedAt=clock.instant();lastSeenAt=issuedAt;expiresAt=minOf(issuedAt.plusSeconds(30*86400L),testAccess?.expiresAt ?: Instant.MAX) }
        sessionRows.insert(row);activity.record(user.id!!)
        return TokenView(token,row.id!!,row.expiresAt)
    }
    fun updateProfile(actor: Actor,input: ProfileInput): MutationResult {
        val user=sql.lockUser(actor.id) ?: unauthenticated();requireVersion(input.expectedVersion,user.version)
        val previous=profiles.selectById(actor.id) ?: missing()
        val college=input.collegeId?.let { directory.college(it) ?: invalid("collegeId") }
        val major=input.majorId?.let { directory.major(it) ?: invalid("majorId") }
        val previousCollege=previous.majorId?.let { directory.major(it)?.collegeId } ?: previous.collegeId
        if(college?.status=="INACTIVE" && college.id!=previousCollege || major?.status=="INACTIVE" && major.id!=previous.majorId) invalid("majorId")
        if(major!=null && input.collegeId!=null && major.collegeId!=input.collegeId) invalid("majorId")
        if(major!=null && major.id!=previous.majorId && directory.college(major.collegeId)?.status!="ACTIVE") invalid("majorId")
        if(input.currentGrade!=null && input.currentGrade !in 1..5) invalid("currentGrade")
        val grade=input.currentGrade ?: previous.grade
        val year=if(input.currentGrade!=null) AcademicGrade.academicYear(LocalDate.now(clock.withZone(ZoneId.of("Asia/Shanghai")))) else previous.gradeAcademicYear
        if(major==null || grade==null) qanda.backend.platform.http.invalid("profile","PROFILE_INCOMPLETE","请选择学院、专业和当前年级")
        user.profileSetupSeen=true
        user.nickname=nickname(input.nickname)
        input.avatar?.let { user.avatar=profileAvatar(it) }
        user.version++;user.updatedAt=clock.instant();users.updateById(user)
        sql.updateProfile(actor.id,null,input.majorId,grade,year)
        return MutationResult(actor.id,user.version)
    }
    fun updateAdminProfile(id: UUID,input: AdminProfileInput): MutationResult {
        val user=sql.lockUser(id) ?: missing();requireVersion(input.expectedVersion,user.version)
        if(sql.testAccountAccess(id)!=null && (input.email!=user.email || input.accountCode!=user.accountCode)) fixedTestCredentials()
        val accountCode=input.accountCode.trim().uppercase(Locale.ROOT).also { if(!it.matches(Regex("[A-Z0-9_-]{2,12}"))) invalid("accountCode") }
        if(users.selectCount(QueryWrapper<UserAccount>().eq("account_code",accountCode).ne("id",id))>0) conflict("ACCOUNT_CODE_UNAVAILABLE","账号已被使用")
        val address=input.email?.trim()?.takeIf { it.isNotEmpty() }?.let { email(it) }
        if(address!=null && sql.userByEmail(address.key)?.id?.let { it!=id }==true) conflict("EMAIL_UNAVAILABLE","该邮箱已被其他账号使用")
        if(input.currentGrade!=null && input.currentGrade !in 1..5) invalid("currentGrade")
        val college=input.collegeId?.let { directory.college(it) ?: invalid("collegeId") }
        val major=input.majorId?.let { directory.major(it) ?: invalid("majorId") }
        if(major!=null && major.collegeId!=college?.id) invalid("majorId")

        val profile=profiles.selectById(id)
        val today=LocalDate.now(clock.withZone(ZoneId.of("Asia/Shanghai")))
        val currentGrade=AcademicGrade.current(profile?.grade,profile?.gradeAcademicYear,today)
        val grade=when {
            input.currentGrade==null -> null
            input.currentGrade==currentGrade -> profile?.grade
            else -> input.currentGrade
        }
        val gradeYear=when {
            input.currentGrade==null -> null
            input.currentGrade==currentGrade -> profile?.gradeAcademicYear
            else -> AcademicGrade.academicYear(today)
        }
        if(profile==null) profiles.insert(UserProfile().apply {
            userId=id;collegeId=if(major==null) college?.id else null;majorId=major?.id;this.grade=grade;gradeAcademicYear=gradeYear
        }) else sql.updateProfile(id,if(major==null) college?.id else null,major?.id,grade,gradeYear)

        if(college!=null && major!=null && grade!=null) sql.markProfileSetupSeen(id)
        val emailChanged=user.emailKey!=address?.key
        user.accountCode=accountCode;user.nickname=nickname(input.nickname);user.email=address?.display;user.emailKey=address?.key
        user.version++
        if(emailChanged) { user.credentialVersion++;sql.revokeUserSessions(id) }
        user.updatedAt=clock.instant()
        sql.updateAdminUser(id,user.accountCode,user.nickname,user.email,user.emailKey,user.version,user.credentialVersion,user.updatedAt)
        return MutationResult(id,user.version)
    }
    fun reset(input: ResetPasswordInput): MutationResult {
        val hash=crypto.prepareStudentPassword(input.newPassword,"newPassword").encoded
        val proof=challengeRows.selectById(input.challengeId) ?: invalidProof();val userId=proof.userId ?: invalidProof()
        val user=sql.lockUser(userId) ?: invalidProof();if(sql.testAccountAccess(userId)!=null) fixedTestCredentials();if(user.status!="ACTIVE") invalidProof()
        challenges.consume(input.challengeId,"RESET_PASSWORD",userId)
        sql.updateCredentials(userId,user.email,user.emailKey,hash);sql.revokeUserSessions(userId)
        return MutationResult(userId,user.version+1)
    }
    fun changePassword(actor: Actor,input: PasswordInput): MutationResult {
        if(sql.testAccountAccess(actor.id)!=null) fixedTestCredentials()
        val user=sql.lockUser(actor.id) ?: unauthenticated();requireVersion(input.expectedVersion,user.version)
        val hash=crypto.prepareStudentPassword(input.newPassword,"newPassword").encoded;challenges.consume(input.challengeId,"CHANGE_PASSWORD",actor.id)
        sql.updateCredentials(actor.id,user.email,user.emailKey,hash);sql.revokeUserSessions(actor.id)
        return MutationResult(actor.id,user.version+1)
    }
    fun changeEmail(actor: Actor,input: EmailInput): MutationResult {
        if(sql.testAccountAccess(actor.id)!=null) fixedTestCredentials()
        val user=sql.lockUser(actor.id) ?: unauthenticated();requireVersion(input.expectedVersion,user.version)
        if(user.email!=null) challenges.consume(input.oldChallengeId ?: invalid("oldChallengeId"),"CHANGE_EMAIL_OLD",actor.id)
        val proof=challenges.consume(input.newChallengeId,if(user.email==null) "BIND_EMAIL" else "CHANGE_EMAIL_NEW",actor.id)
        if(sql.userByEmail(proof.emailKey)!=null) conflict("EMAIL_UNAVAILABLE","邮箱暂不可使用")
        sql.updateCredentials(actor.id,proof.email,proof.emailKey,user.passwordHash);sql.revokeUserSessions(actor.id)
        return MutationResult(actor.id,user.version+1)
    }
    fun bindWechat(actor: Actor,input: WechatBindingInput): MutationResult {
        if(sql.testAccountAccess(actor.id)!=null) fixedTestCredentials()
        val user=sql.lockUser(actor.id) ?: unauthenticated();requireVersion(input.expectedVersion,user.version)
        val identity=wechat.exchange(input.code)
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
