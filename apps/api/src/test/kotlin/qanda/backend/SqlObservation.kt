package qanda.backend

import org.apache.ibatis.executor.statement.StatementHandler
import org.apache.ibatis.plugin.*
import org.springframework.beans.factory.config.BeanPostProcessor
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.jdbc.datasource.AbstractDataSource
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy
import java.sql.*
import javax.sql.DataSource

class SqlObservation {
    data class Query(val sql: String,var rows: Int=0)
    data class Sample(val queries: MutableList<Query> = mutableListOf(),var mybatis: Int=0)
    companion object {
        val current=ThreadLocal<Sample>()
        fun <T> measure(work: () -> T): Pair<T,Sample> {
            val sample=Sample();current.set(sample)
            try { return work() to sample } finally { current.remove() }
        }
        private inline fun <reified T> wrap(target: T,crossinline call: (java.lang.reflect.Method,Array<out Any?>?) -> Any?): T =
            Proxy.newProxyInstance(T::class.java.classLoader,arrayOf(T::class.java)) { _,method,args ->
                try { call(method,args) } catch(error: InvocationTargetException) { throw error.targetException }
            } as T
        private fun connection(source: Connection): Connection = wrap(source) { method,args ->
            val result=method.invoke(source,*(args ?: emptyArray()))
            if(method.name=="prepareStatement" && result is PreparedStatement) {
                val sql=args!![0] as String
                var query: Query?=null
                wrap<PreparedStatement>(result) { operation,parameters ->
                    if(operation.name in setOf("execute","executeQuery","executeUpdate","executeBatch")) {
                        query=current.get()?.let { sample -> Query(sql).also { sample.queries.add(it) } }
                    }
                    val value=operation.invoke(result,*(parameters ?: emptyArray()))
                    if(value is ResultSet) {
                        val observed=query
                        wrap<ResultSet>(value) { read,values ->
                            read.invoke(value,*(values ?: emptyArray())).also { next ->
                                if(read.name=="next" && next==true) observed?.let { it.rows++ }
                            }
                        }
                    } else value
                }
            } else result
        }
    }
    @TestConfiguration(proxyBeanMethods=false)
    class Configuration {
        companion object {
            @Bean @JvmStatic fun observeSql()=object: BeanPostProcessor {
                override fun postProcessAfterInitialization(bean: Any,name: String): Any =
                    if(bean is DataSource) object: AbstractDataSource(),AutoCloseable {
                        override fun getConnection()=connection(bean.connection)
                        override fun getConnection(username: String,password: String)=connection(bean.getConnection(username,password))
                        override fun close() { (bean as? AutoCloseable)?.close() }
                    } else bean
            }
        }
    }
    @Intercepts(Signature(type=StatementHandler::class,method="prepare",args=[Connection::class,Integer::class]))
    class Mybatis : Interceptor {
        override fun intercept(invocation: Invocation): Any? { current.get()?.let { it.mybatis++ };return invocation.proceed() }
    }
}
