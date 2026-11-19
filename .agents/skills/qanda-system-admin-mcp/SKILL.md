---
name: qanda-system-admin-mcp
description: Manage the Qanda administration system through scoped MCP tools for directories, accounts, announcements, feedback, operations and security.
---

# Manage the Qanda system

Discover the connected qanda_system tools. Select the module for the requested task. For missing permissions, identify the exact module and operation the administrator needs to authorize.

Find the target by keyword and inspect its ID and current version. For majors, pass the college ID to list_majors. For updates, pass the target ID at the top level and the current expectedVersion in input. Use a new UUID idempotencyKey for each distinct write and reuse it when retrying that write.

For directory changes, send name, code and status for colleges and majors, and include collegeId for a major. For subjects, send name, description and status. For user profile changes, send nickname, accountCode, email and expectedVersion. To change account status, name the target and effect before submitting ACTIVE or DISABLED. Confirm the intended audience before publishing announcements. Read the current policy and confirm changes to security settings.

After writing, query the affected object and report the result, ID and version. If a version conflicts, re-read the object and show the difference. Keep passwords, verification codes and access tokens out of messages. Use the authenticated web interface for credential collection.
