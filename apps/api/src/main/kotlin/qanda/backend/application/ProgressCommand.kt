package qanda.backend.application

import io.swagger.v3.oas.annotations.media.Schema
import qanda.backend.practice.ProgressAck
import java.time.Instant
import java.util.UUID

data class CommandFailure(val code: String,val message: String,val status: Int)
data class ProgressCommandView(val commandId: UUID,val sessionId: UUID,
    @field:Schema(allowableValues=["ACCEPTING","QUEUED","RETRYING","COMMITTED","REJECTED","DEAD_LETTER"]) val state: String,
    val createdAt: Instant,val updatedAt: Instant,val acknowledgement: ProgressAck?,val failure: CommandFailure?)
