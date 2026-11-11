package qanda.backend.application

import io.swagger.v3.oas.annotations.media.Schema
import qanda.backend.practice.ProgressAck
import java.time.Instant
import java.util.UUID

data class CommandFailure(val code: String,val message: String,val status: Int)
data class ProgressCommandView(val commandId: UUID,val sessionId: UUID,
    @field:Schema(allowableValues=["QUEUED","RETRYING","COMMITTED","REJECTED","DEAD_LETTER"]) val state: String,
    val createdAt: Instant,val updatedAt: Instant,val acknowledgement: ProgressAck?,val failure: CommandFailure?,val result: qanda.backend.practice.ResultView?=null)
data class SyncCheckpoint(val acceptedSequence: Long,val processedSequence: Long,val finishing: Boolean)
data class SyncReceipt(val acknowledgement: ProgressAck,val result: qanda.backend.practice.ResultView?)
