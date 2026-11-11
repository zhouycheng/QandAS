package qanda.backend

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import qanda.backend.practice.*
import java.util.UUID

class PracticeSelectionsTest {
    private fun groups(vararg sizes: Long)=sizes.map { CachedEligibilityGroup(UUID.randomUUID(),it) }
    @Test fun `whole groups stop at first oversized group without skipping ahead`() {
        val g=groups(2,5,1)
        assertEquals(listOf(g[0].id),chooseGroupIds(g,4,false))
        assertEquals(g.take(2).map { it.id },chooseGroupIds(g,7,false))
    }
    @Test fun `only explicitly completed first group may exceed requested count`() {
        val g=groups(21,1)
        assertTrue(chooseGroupIds(g,20,false).isEmpty())
        assertEquals(listOf(g[0].id),chooseGroupIds(g,20,true))
        assertTrue(chooseGroupIds(groups(1001),20,true).isEmpty())
    }
}
