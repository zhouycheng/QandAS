package qanda.backend.identity

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.IntNode
import com.fasterxml.jackson.databind.node.TextNode
import jakarta.servlet.http.HttpServletRequest
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.*
import qanda.backend.platform.http.invalid
import qanda.backend.platform.http.requireVersion
import qanda.backend.platform.security.Actor
import qanda.backend.platform.security.Commands
import qanda.backend.platform.security.requestId
import java.time.LocalDate
import java.util.UUID

data class ExamCountdown(val id: String,val examName: String,val examDate: LocalDate)
data class PracticePreset(val id: String="daily",val name: String="日常练习",val mode: String="practice",
    val feedback: String="IMMEDIATE",val order: String="order",val count: JsonNode=IntNode.valueOf(20),val duration: Int=0)
data class LearningPreferences(val autoOpenAnalysis: Boolean=true,val autoNextWhenCorrect: Boolean=false,
    val optionOutline: Boolean=false,val vibrateOnAnswer: Boolean=false,val fontSize: String="normal",
    val moduleOrder: List<String> = listOf("info","stem","response","tools"),val layoutMode: String="flow",
    val practiceStemPercent: Int=50,val swipeEnabled: Boolean=true,val swipeDraftAction: String="save",
    val examCountdowns: List<ExamCountdown> = emptyList(),val practicePresets: List<PracticePreset> = listOf(PracticePreset()),
    val defaultPracticePresetId: String="daily")
data class PreferencesView(val version: Long,val preferences: LearningPreferences)
data class PreferencesInput(val expectedVersion: Long,val preferences: LearningPreferences)

@Service
class Preferences(private val jdbc: JdbcTemplate,private val identity: IdentityMapper) {
    @Transactional(readOnly=true,isolation=org.springframework.transaction.annotation.Isolation.REPEATABLE_READ)
    fun read(userId: UUID): PreferencesView {
        val exams=jdbc.query("SELECT * FROM user_exam_countdown WHERE user_id=? ORDER BY position",{ r,_ ->
            ExamCountdown(r.getString("id"),r.getString("exam_name"),r.getObject("exam_date",LocalDate::class.java)) },userId)
        val presets=jdbc.query("SELECT * FROM user_practice_preset WHERE user_id=? ORDER BY position",{ r,_ ->
            PracticePreset(r.getString("id"),r.getString("name"),r.getString("mode"),r.getString("feedback"),r.getString("question_order"),
                r.getObject("question_count")?.let { IntNode.valueOf((it as Number).toInt()) } ?: TextNode.valueOf("ALL"),r.getInt("duration")) to r.getBoolean("is_default") },userId)
        return jdbc.query("SELECT * FROM user_settings WHERE user_id=?",{ r,_ ->
            PreferencesView(r.getLong("version"),LearningPreferences(r.getBoolean("auto_open_analysis"),r.getBoolean("auto_next_when_correct"),
                r.getBoolean("option_outline"),r.getBoolean("vibrate_on_answer"),r.getString("font_size"),
                (r.getArray("module_order").array as Array<*>).map { it.toString() },r.getString("layout_mode"),r.getInt("practice_stem_percent"),
                r.getBoolean("swipe_enabled"),r.getString("swipe_draft_action"),exams,presets.map { it.first },presets.single { it.second }.first.id))
        },userId).singleOrNull() ?: PreferencesView(1,LearningPreferences())
    }
    @Transactional
    fun save(actor: Actor,input: PreferencesInput): PreferencesView {
        identity.lockUser(actor.id) ?: unauthenticated()
        val current=read(actor.id)
        requireVersion(input.expectedVersion,current.version)
        val p=input.preferences
        validate(p)
        jdbc.update("""INSERT INTO user_settings(user_id,version,auto_open_analysis,auto_next_when_correct,option_outline,vibrate_on_answer,
            font_size,module_order,layout_mode,practice_stem_percent,swipe_enabled,swipe_draft_action)
            VALUES(?,?,?,?,?,?,?,string_to_array(?,','),?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,auto_open_analysis=excluded.auto_open_analysis,
            auto_next_when_correct=excluded.auto_next_when_correct,option_outline=excluded.option_outline,vibrate_on_answer=excluded.vibrate_on_answer,
            font_size=excluded.font_size,module_order=excluded.module_order,layout_mode=excluded.layout_mode,
            practice_stem_percent=excluded.practice_stem_percent,swipe_enabled=excluded.swipe_enabled,swipe_draft_action=excluded.swipe_draft_action""",
            actor.id,current.version+1,p.autoOpenAnalysis,p.autoNextWhenCorrect,p.optionOutline,p.vibrateOnAnswer,p.fontSize,
            p.moduleOrder.joinToString(","),p.layoutMode,p.practiceStemPercent,p.swipeEnabled,p.swipeDraftAction)
        jdbc.update("DELETE FROM user_exam_countdown WHERE user_id=?",actor.id)
        jdbc.update("DELETE FROM user_practice_preset WHERE user_id=?",actor.id)
        p.examCountdowns.forEachIndexed { index,e -> jdbc.update("INSERT INTO user_exam_countdown(user_id,id,exam_name,exam_date,position) VALUES(?,?,?,?,?)",
            actor.id,e.id,e.examName,e.examDate,index) }
        p.practicePresets.forEachIndexed { index,s -> jdbc.update("""INSERT INTO user_practice_preset(user_id,id,name,mode,feedback,question_order,
            question_count,duration,is_default,position) VALUES(?,?,?,?,?,?,?,?,?,?)""",
            actor.id,s.id,s.name,s.mode,s.feedback,s.order,if(s.count.isIntegralNumber) s.count.intValue() else null,s.duration,s.id==p.defaultPracticePresetId,index) }
        return PreferencesView(current.version+1,p)
    }
    private fun validate(p: LearningPreferences) {
        if(p.fontSize !in setOf("small","normal","large","xlarge","xxlarge") || p.layoutMode !in setOf("flow","custom") ||
            p.moduleOrder.size!=4 || p.moduleOrder.toSet()!=setOf("info","stem","response","tools") ||
            p.practiceStemPercent !in 30..70 || p.practiceStemPercent%5!=0 || p.swipeDraftAction !in setOf("save","confirm")) invalid("/preferences")
        fun id(value: String)=value.matches(Regex("[A-Za-z0-9_-]{1,100}"))
        if(p.examCountdowns.size>100 || p.examCountdowns.map { it.id }.distinct().size!=p.examCountdowns.size || p.examCountdowns.any {
            !id(it.id) || it.examName.isBlank() || it.examName!=it.examName.trim() || it.examName.length>20 || it.examName.any { c -> c.code<32 || c.code==127 } || it.examDate.year !in 1970..9999 }) invalid("/preferences/examCountdowns")
        if(p.practicePresets.size !in 1..100 || p.practicePresets.map { it.id }.distinct().size!=p.practicePresets.size ||
            p.practicePresets.none { it.id==p.defaultPracticePresetId } || p.practicePresets.map { it.copy(id="",name="") }.distinct().size!=p.practicePresets.size) invalid("/preferences/practicePresets")
        p.practicePresets.forEach { s ->
            if(!id(s.id) || s.name.isBlank() || s.name!=s.name.trim() || s.name.length>30 || s.name.any { c -> c.code<32 || c.code==127 } || s.mode !in setOf("practice","test","view") ||
                s.feedback !in setOf("IMMEDIATE","AFTER_FINISH") || s.order !in setOf("order","random") ||
                !(s.count.isIntegralNumber && s.count.canConvertToInt() && s.count.intValue() in 1..1000 || s.count.isTextual && s.count.textValue()=="ALL") ||
                s.duration !in 0..1440 || s.mode=="test" && (s.feedback!="AFTER_FINISH" || s.order!="random") ||
                s.mode=="view" && (s.feedback!="IMMEDIATE" || s.order!="order" || s.duration!=0)) invalid("/preferences/practicePresets")
        }
    }
}

@RestController
@RequestMapping("/api/v1/me/preferences",produces=["application/json"])
class PreferencesController(private val preferences: Preferences,private val sessions: Sessions,private val commands: Commands) {
    @GetMapping fun read(): PreferencesView=preferences.read(sessions.student().id)
    @PutMapping fun save(@RequestBody input: PreferencesInput,@RequestHeader("Idempotency-Key") key: UUID,request: HttpServletRequest): PreferencesView {
        val actor=sessions.student()
        return commands.run(actor,key,"SAVE_PREFERENCES",input,PreferencesView::class.java,request.requestId()) { preferences.save(actor,input) }
    }
}
