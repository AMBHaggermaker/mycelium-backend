# Mycelium API

Community coordination platform backend — needs, offers, events, circles, and dialogue threads.

## Setup

### Prerequisites
- Node.js 18+
- PostgreSQL 16

### 1. Create the database

Connect to PostgreSQL as a superuser and run:

```sql
CREATE USER mycelium_user WITH PASSWORD 'mycelium2026';
CREATE DATABASE mycelium_db OWNER mycelium_user;
GRANT ALL PRIVILEGES ON DATABASE mycelium_db TO mycelium_user;
GRANT ALL ON SCHEMA public TO mycelium_user;
```

### 2. Run the migration

```bash
psql -U mycelium_user -d mycelium_db -f migrations/001_initial.sql
```

### 3. Install dependencies

```bash
npm install
```

### 4. Start the server

```bash
npm start        # production
npm run dev      # auto-restart with nodemon
```

Server runs on **http://localhost:3001** (configured in `.env`).

### Health check

```
GET /api/health
```

```json
{ "status": "ok", "db": "connected", "timestamp": "..." }
```

---

## Authentication

All protected routes require a `Bearer` token in the `Authorization` header:

```
Authorization: Bearer <token>
```

Tokens are returned on register and login.

---

## API Endpoints

### Auth — `/api/auth`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | — | Create account |
| POST | `/api/auth/login` | — | Login, receive token |
| GET | `/api/auth/me` | ✓ | Get current user |

**Register**
```json
POST /api/auth/register
{ "username": "alice", "email": "alice@example.com", "password": "secret123", "bio": "...", "location": "..." }
```

**Login**
```json
POST /api/auth/login
{ "email": "alice@example.com", "password": "secret123" }
```

---

### Users — `/api/users`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/users/:id` | — | Get user profile |
| PATCH | `/api/users/:id` | ✓ (own) | Update profile |
| GET | `/api/users/:id/posts` | — | List user's posts |
| GET | `/api/users/:id/circles` | — | List user's circles |
| GET | `/api/users/:id/reservations` | ✓ (own) | List user's reservations |

**Update profile**
```json
PATCH /api/users/:id
{ "username": "alice2", "bio": "...", "location": "..." }
```

**Query params for `/posts`:** `type`, `status`, `page`, `limit`

---

### Posts — `/api/posts`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/posts` | — | List posts |
| POST | `/api/posts` | ✓ | Create post |
| GET | `/api/posts/:id` | — | Get post |
| PATCH | `/api/posts/:id` | ✓ (owner) | Update post |
| DELETE | `/api/posts/:id` | ✓ (owner) | Delete post |

**Post types:** `need` · `offer` · `event`
**Post statuses:** `active` · `fulfilled` · `cancelled`

**Create post**
```json
POST /api/posts
{
  "type": "event",
  "title": "Community garden workday",
  "description": "...",
  "circle_id": "uuid-optional",
  "capacity": 20,
  "location": "123 Main St",
  "starts_at": "2026-06-01T10:00:00Z",
  "ends_at": "2026-06-01T14:00:00Z",
  "tags": ["garden", "outdoor"]
}
```

**Query params for listing:** `type`, `circle_id`, `status`, `tags` (comma-separated), `page`, `limit`

```
GET /api/posts?type=event&status=active&tags=garden,outdoor&page=1&limit=20
```

---

### Circles — `/api/circles`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/circles` | — | List public circles |
| POST | `/api/circles` | ✓ | Create circle (creator becomes admin) |
| GET | `/api/circles/:id` | — | Get circle + member count |
| PATCH | `/api/circles/:id` | ✓ (admin) | Update circle |
| POST | `/api/circles/:id/join` | ✓ | Join circle |
| DELETE | `/api/circles/:id/leave` | ✓ | Leave circle |
| GET | `/api/circles/:id/members` | — | List members |
| PATCH | `/api/circles/:id/members/:userId` | ✓ (admin) | Change member role |
| GET | `/api/circles/:id/posts` | — | List circle's posts |
| GET | `/api/circles/:id/threads` | — | List circle's threads |

**Create circle**
```json
POST /api/circles
{ "name": "Eastside Growers", "description": "...", "is_private": false }
```

**Change member role**
```json
PATCH /api/circles/:id/members/:userId
{ "role": "admin" }
```

**Roles:** `admin` · `member`

**Query params for listing:** `search`, `page`, `limit`

---

### Threads — `/api/threads`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/threads` | — | List threads |
| POST | `/api/threads` | ✓ | Create thread |
| GET | `/api/threads/:id` | — | Get thread with all messages |
| POST | `/api/threads/:id/messages` | ✓ | Add message |
| PATCH | `/api/threads/:id/messages/:messageId` | ✓ (own) | Edit message |
| DELETE | `/api/threads/:id/messages/:messageId` | ✓ (own) | Delete message |

**Create thread** (requires `post_id` or `circle_id`)
```json
POST /api/threads
{ "title": "Questions about the garden workday", "post_id": "uuid", "circle_id": "uuid" }
```

**Add message**
```json
POST /api/threads/:id/messages
{ "content": "Will tools be provided?" }
```

**Query params for listing:** `circle_id`, `post_id`, `page`, `limit`

---

### Search — `/api/search`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/search` | — | Search posts, circles, and users |

**Query params:**

| Param | Values | Description |
|-------|--------|-------------|
| `q` | string | **Required.** Search term |
| `type` | `all` · `posts` · `circles` · `users` | What to search (default: `all`) |
| `circle_id` | uuid | Narrow post search to a circle |
| `post_type` | `need` · `offer` · `event` | Narrow post type |
| `limit` | number | Results per type (default: 20) |

```
GET /api/search?q=garden&type=posts&post_type=event
GET /api/search?q=eastside&type=circles
GET /api/search?q=alice&type=users
```

---

### Reservations — `/api/reservations`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/reservations` | ✓ | List my outgoing reservations |
| GET | `/api/reservations/incoming` | ✓ | List reservations on my posts |
| POST | `/api/reservations` | ✓ | Reserve a post |
| GET | `/api/reservations/:id` | ✓ (parties) | Get single reservation |
| PATCH | `/api/reservations/:id` | ✓ (parties) | Update status |
| DELETE | `/api/reservations/:id` | ✓ (own) | Cancel and delete |

**Reservation statuses:** `pending` → `confirmed` → `completed` · `cancelled`

**Create reservation**
```json
POST /api/reservations
{ "post_id": "uuid", "notes": "I can bring my own gloves" }
```

**Update status** (post owner confirms/completes; either party cancels)
```json
PATCH /api/reservations/:id
{ "status": "confirmed" }
```

**Complete with reliability rating** (post owner only, rating 1–10)
```json
PATCH /api/reservations/:id
{ "status": "completed", "rating": 9 }
```

Ratings update the reserver's `reliability_score` using an exponential moving average.

**Query params for listing:** `status`, `page`, `limit`

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `mycelium_db` | Database name |
| `DB_USER` | `mycelium_user` | Database user |
| `DB_PASSWORD` | — | Database password |
| `JWT_SECRET` | — | Secret for signing tokens |
| `JWT_EXPIRES_IN` | `7d` | Token expiry |

---

## Database Schema

```
users            — accounts with reliability scores
circles          — community groups (public or private)
circle_members   — user↔circle with admin/member roles
posts            — needs, offers, events with capacity tracking
reservations     — bookings with atomic capacity enforcement
threads          — dialogue threads attached to posts or circles
thread_messages  — replies within threads
```
