# User authorization

Inspect the tools visible on the original MCP connection. Looking up destinations needs `banks:read`; importing also needs `banks:write`. Editing a published bank requires `banks:publish`. Request only the grants needed for the user's task.

For a missing or expired connection or insufficient grants, explain the missing permission and start the MCP client's connect or reauthorize flow. Open its complete, freshly generated authorization URL in a **user-visible browser**. Preserve the client's query parameters, callback, state and PKCE challenge. A bare `/agent-authorize` URL cannot resume this request. If the host cannot open the browser, give the user the client's complete clickable URL. If the host cannot initiate OAuth, direct the user to Connect on that MCP connection.

Hand control to the user as soon as the page opens. The user signs in, reviews the client and permissions and clicks **同意授权**. Never click consent for the user, call the approval endpoint, or ask for credentials, codes or tokens in chat. Wait for the client callback. On cancellation or refusal, stop remote work. On return, rediscover tools on the same connection. Continue only when the required grants are effective; otherwise report the missing grant and pending operation.
