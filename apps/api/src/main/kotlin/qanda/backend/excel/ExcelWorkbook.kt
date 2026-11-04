package qanda.backend.excel

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import org.apache.poi.xssf.usermodel.XSSFWorkbook
import org.apache.poi.ss.usermodel.*
import org.apache.poi.ss.util.CellRangeAddress
import java.io.ByteArrayOutputStream
import java.util.UUID

data class ExcelIssue(val file: String,val sheet: String,val row: Int,val column: String,val message: String)
class WorkbookProblem(val sheet: String,val row: Int,val column: String,message: String): IllegalArgumentException(message)

/** File-only codec, also used by the offline packager; it has no database or network dependencies. */
object ExcelWorkbook {
    val json=ObjectMapper()
    val userColumns=linkedMapOf("id" to "记录编号","email" to "邮箱","nickname" to "昵称","accountCode" to "账号","status" to "状态","registeredAt" to "注册时间","college" to "学院","major" to "专业","currentGrade" to "当前年级","systemId" to "系统记录编号")
    private val questionColumns=linkedMapOf("id" to "题号","chapterId" to "章节编号","parent" to "题组编号","type" to "题型","stem" to "题干","correctAnswer" to "标准选项","correctValue" to "判断答案","referenceAnswer" to "参考答案","explanation" to "解析","passage" to "阅读材料","contentFormat" to "正文格式","presentation" to "展示方式","codeLanguage" to "代码语言","status" to "状态","systemId" to "系统记录编号")
    private val layouts=linkedMapOf(
        "用户" to userColumns,
        "题库信息" to linkedMapOf("id" to "文件编号","subject" to "课程","name" to "题库名称","description" to "说明","textbook" to "教材","systemId" to "系统记录编号"),
        "章节" to linkedMapOf("id" to "章节编号","name" to "名称","sortOrder" to "顺序"),
        "题目" to questionColumns,
        "选项" to linkedMapOf("question" to "题号","key" to "选项标识","content" to "内容"),
        "填空答案" to linkedMapOf("question" to "题号","blank" to "空位编号","answer" to "候选答案","ignoreCase" to "忽略大小写","trimWhitespace" to "忽略首尾空白"),
        "参考要点" to linkedMapOf("question" to "题号","content" to "内容"),
        "来源说明" to linkedMapOf("question" to "题号","content" to "来源与AI参与说明"),
        "附件" to linkedMapOf("id" to "附件编号","path" to "文件路径","question" to "题号"),
        "长文本" to linkedMapOf("sheet" to "工作表","record" to "记录编号","field" to "字段","part" to "片段序号","content" to "内容")
    )
    private fun recordKey(row: ObjectNode,index: Int): String = row.path("id").asText().ifBlank {
        if(row.has("question") && row.has("key")) "option:${row.path("question").asText()}:${row.path("key").asText()}"
        else "row:"+row.path("_excelRow").asInt(index+2)
    }
    private fun fail(sheet: String,row: Int,column: String,message: String): Nothing=throw WorkbookProblem(sheet,row,column,message)
    fun write(document: JsonNode,kind: String): ByteArray {
        val tables=linkedMapOf<String,MutableList<ObjectNode>>()
        fun table(name: String)=tables.getOrPut(name) { mutableListOf() }
        fun row(vararg values: Pair<String,Any?>): ObjectNode=json.valueToTree(values.toMap())
        if(kind=="users") table("用户").addAll(document.path("users").map { it.deepCopy<ObjectNode>() })
        else {
            val bank=document.path("bank")
            table("题库信息").add(row("id" to document.path("fileId").asText(UUID.randomUUID().toString()),"subject" to document.path("subject").asText(bank.path("name").asText()),"name" to bank.path("name").asText(),"description" to bank.path("description").asText(),"textbook" to bank.path("textbook").asText(),"systemId" to bank.path("systemId").asText()))
            document.path("chapters").forEachIndexed { i,c -> table("章节").add(c.deepCopy<ObjectNode>().put("sortOrder",i)) }
            fun question(q: JsonNode,parent: String="") {
                val id=q.path("id").asText();val r=q.deepCopy<ObjectNode>()
                r.put("parent",parent)
                if(q.has("correctAnswer")) r.put("correctAnswer",q["correctAnswer"].joinToString(",") { it.asText() })
                table("题目").add(r)
                q.path("options").forEach { o -> table("选项").add(row("question" to id,"key" to o.path("key").asText(),"content" to o.path("content").asText())) }
                q.path("blanks").forEachIndexed { i,b -> b.path("answers").forEach { a -> table("填空答案").add(row("question" to id,"blank" to i+1,"answer" to a.asText(),"ignoreCase" to q.path("blankMatch").path("ignoreCase").asBoolean(true),"trimWhitespace" to q.path("blankMatch").path("trimWhitespace").asBoolean(true))) } }
                q.path("scoringPoints").forEach { table("参考要点").add(row("question" to id,"content" to it.asText())) }
                if(q.has("provenance")) table("来源说明").add(row("question" to id,"content" to q["provenance"].toString()))
                q.path("assetIds").forEach { a -> val asset=document.path("assets").find { it.path("id").asText()==a.asText() };table("附件").add(row("id" to a.asText(),"path" to (asset?.path("path")?.asText() ?: ""),"question" to id)) }
                q.path("subQuestions").forEach { question(it,id) }
            }
            document.path("questions").forEach { question(it) }
            layouts.keys.filter { it!="用户" }.forEach { table(it) }
        }
        val long=table("长文本")
        tables.toMap().filterKeys { it!="长文本" }.forEach { (name,rows) -> rows.forEachIndexed { index,r -> layouts.getValue(name).keys.forEach { key ->
            val value=r.path(key).asText("")
            if(value.length>30000 || value.count { it=='\n' }>200) {
                var start=0;var part=1
                while(start<value.length) {
                    var end=minOf(start+30000,value.length);var lines=0
                    for(i in start until end) if(value[i]=='\n' && ++lines>200) { end=i;break }
                    if(end<value.length && Character.isHighSurrogate(value[end-1])) end--
                    long.add(row("sheet" to name,"record" to recordKey(r,index),"field" to key,"part" to part++,"content" to value.substring(start,end)))
                    start=end
                }
                r.put(key,"")
            }
        } } }
        XSSFWorkbook().use { book ->
            val style=book.createCellStyle().apply { fillForegroundColor=IndexedColors.DARK_TEAL.index;fillPattern=FillPatternType.SOLID_FOREGROUND;setFont(book.createFont().apply { bold=true;color=IndexedColors.WHITE.index }) }
            val text=book.createCellStyle().apply { dataFormat=book.createDataFormat().getFormat("@");wrapText=true;verticalAlignment=VerticalAlignment.TOP }
            val info=book.createSheet("填写说明")
            listOf("题小搭 Excel 1.0 · $kind","文件编号",document.path("fileId").asText(UUID.randomUUID().toString()),"只新增；冲突记录请修正后导入。编号必须保持稳定。","用户：邮箱、昵称必填；状态 ACTIVE / DISABLED；注册时间使用 ISO 8601（包含时区）。","题型：SINGLE_CHOICE / MULTIPLE_CHOICE / TRUE_FALSE / FILL_BLANK / SHORT_ANSWER / READING。","多选标准选项用逗号分隔，例如 A,C；判断答案 true / false。","阅读小题填写题组编号；填空答案每行一个候选，空位编号从 1 开始。","正文格式 MARKDOWN / PLAIN_TEXT；展示方式 STANDARD / CONCEPT / CODE_ANALYSIS。","长文本按工作表、记录编号、字段和片段序号原样拼接；普通单元格保持空白。","图片在附件表填写相对文件路径，并随 Excel 提交原始文件。","示例：题目 Q1 / SINGLE_CHOICE / 题干示例 / 标准选项 A；在选项表填写 Q1、A、选项内容。")
                .forEachIndexed { i,v -> info.createRow(i).createCell(0).apply { setCellValue(v);cellStyle=text } }
            info.setColumnWidth(0,120*256)
            tables.forEach { (name,rows) ->
                val sheet=book.createSheet(name);val columns=layouts.getValue(name)
                columns.values.forEachIndexed { i,title -> val header=sheet.getRow(0) ?: sheet.createRow(0);header.createCell(i).apply { setCellValue(title);cellStyle=style };sheet.setColumnWidth(i,if(i==0) 24*256 else 30*256);sheet.setDefaultColumnStyle(i,text) }
                rows.forEachIndexed { index,r -> val line=sheet.createRow(index+1);columns.keys.forEachIndexed { i,key -> line.createCell(i,CellType.STRING).apply { setCellValue(r.path(key).asText(""));cellStyle=text } } }
                sheet.createFreezePane(0,1);sheet.setAutoFilter(CellRangeAddress(0,maxOf(1,rows.size),0,columns.size-1))
                listOf("status" to (if(name=="用户") arrayOf("ACTIVE","DISABLED") else arrayOf("ACTIVE","INACTIVE")),"type" to arrayOf("SINGLE_CHOICE","MULTIPLE_CHOICE","TRUE_FALSE","FILL_BLANK","SHORT_ANSWER","READING")).forEach { (key,choices) ->
                    val column=columns.keys.indexOf(key);if(column>=0) sheet.addValidationData(sheet.dataValidationHelper.createValidation(sheet.dataValidationHelper.createExplicitListConstraint(choices),org.apache.poi.ss.util.CellRangeAddressList(1,10000,column,column)))
                }
            }
            return ByteArrayOutputStream().also { book.write(it) }.toByteArray()
        }
    }
    fun read(bytes: ByteArray,kind: String): ObjectNode {
        require(bytes.size<=8*1024*1024) { "Excel 文件最多 8 MiB" }
        org.apache.poi.openxml4j.util.ZipSecureFile.setMaxEntrySize(16L*1024*1024)
        XSSFWorkbook(bytes.inputStream()).use { book ->
            require(book.getSheet("填写说明")?.getRow(0)?.getCell(0)?.stringCellValue in setOf("题小搭 Excel 1.0 · $kind","QandA Excel 1.0 · $kind")) { "模板类型或版本不匹配" }
            require(book.packagePart.`package`.parts.filter { !it.isRelationshipPart }.none { p -> p.relationships.any { it.targetMode==org.apache.poi.openxml4j.opc.TargetMode.EXTERNAL } }) { "不支持外部链接" }
            require(book.getExternalLinksTable().isEmpty()) { "不支持外部链接" }
            require(book.packagePart.`package`.parts.none { it.partName.name.contains("vbaProject",true) || it.partName.name.contains("externalLink",true) }) { "不支持宏或外部链接" }
            val tables=linkedMapOf<String,MutableList<ObjectNode>>()
            book.forEach { sheet ->
                if(sheet.lastRowNum>100000) fail(sheet.sheetName,1,"","工作表行数超限")
                sheet.forEach { r -> r.forEach { c -> if(c.cellType==CellType.FORMULA) fail(sheet.sheetName,r.rowNum+1,c.address.formatAsString(),"请使用文本值，不支持公式") } }
                val columns=layouts[sheet.sheetName] ?: return@forEach
                val header=sheet.getRow(0) ?: fail(sheet.sheetName,1,"","缺少表头")
                if(header.map { it.stringCellValue }!=columns.values.toList()) fail(sheet.sheetName,1,"","表头与模板不一致")
                val rows=mutableListOf<ObjectNode>();tables[sheet.sheetName]=rows
                for(index in 1..sheet.lastRowNum) {
                    val line=sheet.getRow(index) ?: continue;val r=json.createObjectNode()
                    columns.keys.forEachIndexed { c,key -> val cell=line.getCell(c);if(cell!=null && cell.cellType !in setOf(CellType.STRING,CellType.BLANK)) fail(sheet.sheetName,index+1,columns.getValue(key),"请按文本填写，避免编号、日期和答案被自动转换");r.put(key,cell?.stringCellValue ?: "") }
                    if(r.any { it.asText().isNotEmpty() }) { r.put("_excelRow",index+1);rows.add(r) }
                }
            }
            tables["长文本"].orEmpty().groupBy { Triple(it.path("sheet").asText(),it.path("record").asText(),it.path("field").asText()) }.forEach { (key,parts) ->
                val target=tables[key.first]?.withIndex()?.singleOrNull { recordKey(it.value,it.index)==key.second }?.value ?: fail("长文本",2,"记录编号","长文本记录引用不存在或不唯一")
                require(layouts[key.first]?.containsKey(key.third)==true && target.path(key.third).asText().isEmpty()) { "长文本字段无效或与正文重复" }
                val ordered=parts.sortedBy { it.path("part").asText().toIntOrNull() ?: 0 }
                require(ordered.map { it.path("part").asText().toIntOrNull() }==(1..ordered.size).toList()) { "长文本片段必须连续且唯一" }
                target.put(key.third,ordered.joinToString("") { it.path("content").asText() })
            }
            tables.values.forEach { rows -> rows.forEach { it.remove("_excelRow") } }
            val out=json.createObjectNode();out.put("fileId",book.getSheet("填写说明")?.getRow(2)?.getCell(0)?.stringCellValue ?: error("缺少文件编号"))
            require(out.path("fileId").asText().matches(Regex("[A-Za-z0-9_.-]{1,80}"))) { "文件编号无效" }
            if(kind=="users") { require(tables.containsKey("用户")) { "缺少用户工作表" };out.set<JsonNode>("users",json.valueToTree(tables.getValue("用户")));return out }
            val bank=tables["题库信息"]?.singleOrNull() ?: error("题库信息必须为一行")
            out.put("subject",bank.path("subject").asText());out.set<JsonNode>("bank",bank)
            val chapters=tables["章节"].orEmpty().mapIndexed { index,c ->
                val order=c.path("sortOrder").asText().ifBlank { index.toString() }.toIntOrNull()
                if(order==null || order<0) fail("章节",index+2,"顺序","顺序须为非负整数")
                c to order
            }
            require(chapters.map { it.second }.distinct().size==chapters.size) { "章节顺序重复" }
            out.set<JsonNode>("chapters",json.valueToTree(chapters.sortedBy { it.second }.map { it.first }))
            val rows=tables["题目"].orEmpty();val questions=linkedMapOf<String,ObjectNode>()
            rows.forEachIndexed { index,r ->
                val id=r.path("id").asText();if(id.isBlank() || questions.put(id,r)!=null) fail("题目",index+2,"题号","题号为空或重复")
                r.putArray("options");r.putArray("blanks");r.putArray("scoringPoints");r.putArray("assetIds");r.putArray("subQuestions")
                val answer=r.path("correctAnswer").asText();r.set<JsonNode>("correctAnswer",json.valueToTree(if(answer.isBlank()) emptyList<String>() else answer.split(',').map { it.trim() }))
                if(r.path("correctValue").asText().isNotBlank()) { require(r.path("correctValue").asText() in setOf("true","false")) { "判断答案须为 true 或 false" };r.put("correctValue",r.path("correctValue").asText()=="true") } else r.remove("correctValue")
                listOf("referenceAnswer","passage","chapterId","codeLanguage").forEach { if(r.path(it).asText().isEmpty()) r.remove(it) }
                if(r.path("contentFormat").asText().isEmpty()) r.put("contentFormat","MARKDOWN")
                if(r.path("presentation").asText().isEmpty()) r.put("presentation","STANDARD")
                if(r.path("status").asText().isEmpty()) r.put("status","ACTIVE")
            }
            fun referenced(r: ObjectNode)=questions[r.path("question").asText()] ?: fail("关联工作表",2,"题号","题号引用不存在")
            tables["选项"].orEmpty().forEach { r -> referenced(r).withArray("options").add(json.createObjectNode().put("key",r.path("key").asText()).put("content",r.path("content").asText())) }
            tables["填空答案"].orEmpty().groupBy { it.path("question").asText() }.forEach { (_,answers) ->
                val q=referenced(answers.first());val groups=answers.groupBy { it.path("blank").asText().toIntOrNull() ?: 0 }.toSortedMap()
                require(groups.keys.toList()==(1..groups.size).toList()) { "空位编号必须从 1 连续排列" }
                groups.values.forEach { values -> q.withArray("blanks").add(json.createObjectNode().set<JsonNode>("answers",json.valueToTree(values.map { it.path("answer").asText() }))) }
                val settings=answers.map { it.path("ignoreCase").asText("true") to it.path("trimWhitespace").asText("true") }.distinct();require(settings.size==1 && settings[0].toList().all { it in setOf("true","false") }) { "填空匹配规则不一致" }
                q.set<JsonNode>("blankMatch",json.createObjectNode().put("ignoreCase",settings[0].first=="true").put("trimWhitespace",settings[0].second=="true"))
            }
            tables["参考要点"].orEmpty().forEach { referenced(it).withArray("scoringPoints").add(it.path("content").asText()) }
            tables["来源说明"].orEmpty().forEach { referenced(it).set<JsonNode>("provenance",json.readTree(it.path("content").asText())) }
            out.putArray("assets")
            val assetPaths=mutableMapOf<String,String>()
            tables["附件"].orEmpty().forEachIndexed { index,r ->
                val id=r.path("id").asText();val path=r.path("path").asText()
                if(id.isBlank()) fail("附件",index+2,"附件编号","附件编号必填")
                val previous=assetPaths.putIfAbsent(id,path)
                if(previous!=null && previous!=path) fail("附件",index+2,"文件路径","同一附件编号必须使用相同文件路径")
                referenced(r).withArray("assetIds").add(id);out.withArray("assets").add(r)
            }
            val roots=out.putArray("questions")
            rows.forEach { r -> val parent=r.path("parent").asText();if(parent.isEmpty()) roots.add(r) else { val owner=questions[parent] ?: error("阅读题组不存在");require(owner.path("type").asText()=="READING" && r.path("type").asText()!="READING" && owner.path("parent").asText().isEmpty()) { "阅读题组关系无效" };owner.withArray("subQuestions").add(r) };r.remove("parent") }
            return out
        }
    }
}
