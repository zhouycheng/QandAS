package qanda.backend

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import qanda.backend.identity.AcademicGrade
import java.time.LocalDate

class AcademicGradeTest {
    @Test fun `grade advances on September first and graduation stays final`() {
        assertEquals(2025,AcademicGrade.academicYear(LocalDate.parse("2026-08-31")))
        assertEquals(2,AcademicGrade.current(2,2025,LocalDate.parse("2026-08-31")))
        assertEquals(3,AcademicGrade.current(2,2025,LocalDate.parse("2026-09-01")))
        assertEquals(5,AcademicGrade.current(4,2025,LocalDate.parse("2026-09-01")))
        assertEquals(5,AcademicGrade.current(5,2025,LocalDate.parse("2030-09-01")))
        assertEquals(1,AcademicGrade.current(1,2026,LocalDate.parse("2026-09-01")))
        assertNull(AcademicGrade.current(null,null,LocalDate.parse("2026-09-01")))
    }
}
