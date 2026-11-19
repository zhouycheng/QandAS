package qanda.backend.platform.http

import jakarta.servlet.http.HttpServletRequest
import org.springframework.web.context.request.RequestContextHolder
import org.springframework.web.context.request.ServletRequestAttributes

/** A compatibility branch can run many times while rendering one response. */
object CompatibilityUsage {
    private const val KEY = "qanda.compatibility.items"
    fun mark(item: String) {
        val request = (RequestContextHolder.getRequestAttributes() as? ServletRequestAttributes)?.request ?: return
        @Suppress("UNCHECKED_CAST")
        val items = request.getAttribute(KEY) as? MutableSet<String> ?: linkedSetOf<String>().also { request.setAttribute(KEY,it) }
        items.add(item)
    }
    fun items(request: HttpServletRequest) = (request.getAttribute(KEY) as? Set<*>)?.filterIsInstance<String>().orEmpty()
}
