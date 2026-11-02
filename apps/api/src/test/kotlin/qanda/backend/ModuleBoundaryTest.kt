package qanda.backend

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertTrue
import java.lang.reflect.*
import java.nio.file.Files
import java.nio.file.Path

class ModuleBoundaryTest {
    @Test fun `SQL includes resolve and cross module fragments use published read contracts`() {
        val files=Files.list(Path.of("src/main/resources/mapper")).use { it.toList() }
        val namespaces=files.associate { file ->
            val factory=javax.xml.parsers.DocumentBuilderFactory.newInstance()
            factory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd",false)
            val document=factory.newDocumentBuilder().parse(file.toFile())
            document.documentElement.getAttribute("namespace") to document
        }
        namespaces.forEach { (namespace,document) ->
            val includes=document.getElementsByTagName("include")
            for(i in 0 until includes.length) {
                val ref=(includes.item(i) as org.w3c.dom.Element).getAttribute("refid")
                val owner=if('.' in ref) ref.substringBeforeLast('.') else namespace
                val fragments=namespaces[owner]?.getElementsByTagName("sql")
                assertTrue(fragments!=null && (0 until fragments.length).any { (fragments.item(it) as org.w3c.dom.Element).getAttribute("id")==ref.substringAfterLast('.') },"Unresolved SQL fragment: $namespace -> $ref")
                assertTrue(module(namespace)==module(owner) || ".api." in owner,"Private SQL import: $namespace -> $ref")
            }
        }
    }
    private fun module(name: String): String? = when {
        name.startsWith("qanda.backend.application.") -> "application"
        name.startsWith("qanda.backend.platform.files.") -> "content"
        name.startsWith("qanda.backend.platform.mail.") -> "account"
        else -> when(name.removePrefix("qanda.backend.").substringBefore('.')) {
            "identity","admin" -> "account";"catalog" -> "catalog";"content" -> "content"
            "learning","discovery" -> "learning";"practice" -> "practice";"sync" -> "sync"
            "announcements" -> "announcements";"operations" -> "feedback";"monitoring" -> "monitoring"
            else -> null
        }
    }
    private fun classes(): List<Class<*>> = Files.walk(Path.of("target/classes/qanda/backend")).use { paths ->
        paths.filter { it.toString().endsWith(".class") }.map { path ->
            val name=Path.of("target/classes").relativize(path).toString().removeSuffix(".class").replace('/','.')
            Class.forName(name,false,javaClass.classLoader)
        }.toList()
    }
    private fun types(type: Type): List<Class<*>> = when(type) {
        is Class<*> -> listOf(type)
        is ParameterizedType -> types(type.rawType)+type.actualTypeArguments.flatMap(::types)
        is WildcardType -> type.upperBounds.flatMap(::types)+type.lowerBounds.flatMap(::types)
        else -> emptyList()
    }
    @Test fun `module internals stay with their owner and service dependencies are acyclic`() {
        val classes=classes()
        val internals=classes.filter { c -> c.annotations.any { it.annotationClass.java.name in setOf("org.apache.ibatis.annotations.Mapper","com.baomidou.mybatisplus.annotation.TableName") } }.toSet()
        val violations=mutableListOf<String>()
        val graph=mutableMapOf<String,MutableSet<String>>()
        classes.forEach { owner ->
            val source=module(owner.name) ?: return@forEach
            if(source=="application") return@forEach
            val referenced=owner.declaredFields.flatMap { types(it.genericType) }+owner.declaredMethods.flatMap { types(it.genericReturnType)+it.genericParameterTypes.flatMap(::types) }
            referenced.filter { it in internals && module(it.name)!=source }.forEach { violations+="${owner.name} exposes ${it.name}" }
            if(owner.annotations.any { it.annotationClass.java.name in setOf("org.springframework.stereotype.Service","org.springframework.stereotype.Component") }) {
                owner.declaredFields.flatMap { types(it.genericType) }.mapNotNull { module(it.name) }.filter { it!=source && it!="application" }.forEach { graph.getOrPut(source) { mutableSetOf() }.add(it) }
            }
        }
        fun visit(node: String,path: List<String>) {
            if(node in path) { violations+="Service cycle: ${(path+node).joinToString(" -> ")}";return }
            graph[node].orEmpty().forEach { visit(it,path+node) }
        }
        graph.keys.forEach { visit(it,emptyList()) }
        assertTrue(violations.isEmpty(),violations.distinct().joinToString("\n"))
    }
}
