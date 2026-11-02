package qanda.backend.identity

import java.time.LocalDate

object AcademicGrade {
    fun academicYear(date: LocalDate): Int = date.year - if (date.monthValue < 9) 1 else 0
    fun current(grade: Int?, year: Int?, date: LocalDate): Int? =
        if (grade == null || year == null) null else (grade + (academicYear(date) - year).coerceAtLeast(0)).coerceAtMost(5)
}
