# Service boundaries and API ownership

## Decisions

- FastAPI `/api/auth/*` is the only JWT issuer. Express services validate those JWTs with the shared secret; they do not issue replacement tokens.
- FastAPI currently owns messaging REST endpoints and the `/api/messages/ws/{user_id}` WebSocket. The Express notification service owns notification APIs and the SSE stream. Chat is not part of the notification service.
- Express post service owns posts, comments, reactions, uploads, and content visibility state.
- Express moderation service owns reports, appeals, moderation decisions, and the admin review dashboard APIs.
- The standalone AI Inference Service owns `/api/v1/moderate/*` and `/api/moderate/*`. It imports the inference router and model code, but no longer imports the complete `backend.main` application.
- The Node user service owns `/api/users/*` profile and role management today, while FastAPI owns auth and issues JWTs. This means the User/Auth context is still split across Node and FastAPI. Do not describe it as a single independently deployed User/Auth service until those APIs are consolidated.

## API routing

| API path | Current receiving service | Responsibility |
| --- | --- | --- |
| `/api/auth/*`, `/api/v1/auth/*` | FastAPI platform application (port 8000) | Register, login, OTP, password recovery; sole JWT issuer |
| `/api/users/*` | Express user service (port 5001) | Profiles, roles, sanctions, trust history, user administration |
| `/api/posts/*`, `/api/stories/*`, `/api/groups/*`, `/api/hashtags/*`, `/api/upload/*` | Express post service (port 5002) | Posts, comments, reactions, shares, stories, community groups, hashtags, uploads, image appeals |
| `/api/reports/*`, `/api/appeals/*`, `/api/admin/*` | Express moderation service (port 5003) | Reports, appeals, decisions, AI override logs, moderation dashboard |
| `/api/notifications/*`, `/api/realtime/stream` | Express notification service (port 5004) | User notifications and SSE broadcast stream |
| `/api/friends/*`, `/api/messages/*`, `/api/livestreams/*`, `/api/settings/*`, `/api/search/*` | FastAPI platform application (port 8000) | Friendships, chat, livestreams, settings, search |
| `/api/v1/moderate/*`, `/api/moderate/*` | Standalone AI inference service (port 8001) | Text (PhoBERT) and image (EfficientNet-B1) analysis |

`/api/*` is the canonical public route family. `/api/v1/*` remains as a compatibility alias and routes to the same owning service through the gateway.

## Service directory layout (3-layer Node architecture)

Each Node.js microservice under `services/` follows a consistent 3-layer layout (`routes` -> `controllers` -> `repositories`):

- `services/user-service/src/` — `routes/usersRouter.js`, `controllers/usersController.js`, `repositories/userRepository.js`
- `services/post-service/src/` — `routes/` (`postsRouter`, `postReactionsRouter`, `storiesRouter`, `communityGroupsRouter`, `hashtagsRouter`, `uploadRouter`, `imagePreviewRouter`, `moderationAppealRouter`), `controllers/` (`postsController`, `postReactionsController`, `storiesController`, `uploadController`), `repositories/` (`postRepository`, `reactionRepository`, `storyRepository`, `communityGroupsRepository`, `hashtagRepository`)
- `services/moderation-service/src/` — `routes/` (`adminRouter`, `appealsRouter`, `reportsRouter`, `imageModerationRouter`), `controllers/` (`adminController`, `appealsController`, `reportsController`), `repositories/` (`adminRepository`, `appealRepository`, `reportRepository`)
- `services/notification-service/src/` — `routes/` (`notificationsRouter`, `realtimeRouter`), `controllers/notificationsController.js`, `repositories/notificationRepository.js`
- `services/ai-service/` — standalone FastAPI app (`main.py`) exposing PhoBERT and EfficientNet inference on port `8001`

## Gateway configuration

The gateway route registry is in `gateway/server.js`. Upstream URLs can be configured with `PLATFORM_SERVICE_URL`, `AI_SERVICE_URL`, `USER_SERVICE_URL`, `POST_SERVICE_URL`, `MODERATION_SERVICE_URL`, and `REALTIME_SERVICE_URL`. Local defaults use loopback; Docker Compose sets service DNS names. Browser API calls use the gateway as their base URL. Only the gateway and frontend publish host ports in the microservices Compose file.

Current limitation: the AI service has its own FastAPI app, but its router and inference modules still live under `backend/app`. All four Node services (`user-service`, `post-service`, `moderation-service`, `notification-service`) now own their `routes`, `controllers`, and `repositories` under `services/<service>/src/`, while `backend/src/` retains lightweight compatibility re-exports for shared utilities and legacy imports. PostgreSQL `NOTIFY` carries feed events between Social Content, Moderation, and Realtime processes during the shared-database phase. The User/Auth APIs are not yet consolidated into one runtime service.

Table write owners and the migration path are recorded in `database/service-ownership.md`.
