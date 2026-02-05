# CLAUDE.md - Project Context for AI Assistants

This file provides context for AI assistants (like Claude) working on this codebase.

## Project Overview

**EA-SYS (Event Administration System)** is a full-stack event management platform built with Next.js. It enables organizations to manage conferences, meetings, and events including registrations, speakers, schedules, accommodations, and communications.

## Tech Stack

- **Framework:** Next.js 16 (App Router)
- **Language:** TypeScript
- **Database:** PostgreSQL with Prisma ORM
- **Authentication:** NextAuth.js v5 with JWT strategy
- **Styling:** TailwindCSS + Shadcn/ui components
- **Email:** Brevo (formerly Sendinblue)
- **Deployment:** Vercel

## Project Structure

```
src/
├── app/
│   ├── (auth)/              # Auth pages (login, accept-invitation)
│   ├── (dashboard)/         # Protected dashboard pages
│   │   ├── dashboard/       # Main dashboard
│   │   ├── events/          # Event management
│   │   │   └── [eventId]/   # Single event pages
│   │   │       ├── registrations/
│   │   │       ├── speakers/
│   │   │       ├── schedule/
│   │   │       ├── accommodation/
│   │   │       ├── tickets/
│   │   │       ├── abstracts/
│   │   │       └── settings/
│   │   └── settings/        # Organization settings
│   ├── e/                   # Public event pages (no auth)
│   │   └── [slug]/          # Event registration page
│   │       └── confirmation/
│   └── api/                 # API routes
│       ├── auth/            # Auth endpoints
│       ├── events/          # Event CRUD (protected)
│       │   └── [eventId]/   # Event-specific endpoints
│       ├── organization/    # Organization endpoints
│       └── public/          # Public API (no auth required)
│           └── events/[slug]/ # Public event details & registration
├── components/
│   ├── layout/              # Header, Sidebar
│   └── ui/                  # Shadcn/ui components
├── contexts/                # React contexts
├── lib/                     # Utilities
│   ├── auth.ts              # NextAuth configuration
│   ├── db.ts                # Prisma client
│   ├── email.ts             # Brevo email service
│   ├── logger.ts            # Pino logger
│   └── utils.ts             # Helper functions
└── types/                   # TypeScript types
```

## Key Files

- `prisma/schema.prisma` - Database schema
- `src/lib/auth.ts` - Authentication configuration
- `src/lib/email.ts` - Email templates and sending
- `src/app/globals.css` - Global styles and CSS variables

## Database Models

- **Organization** - Organization entity (currently single-org mode)
- **User** - Users with roles (SUPER_ADMIN, ADMIN, ORGANIZER, REVIEWER)
- **Event** - Events with status tracking
- **TicketType** - Ticket configurations
- **Registration** - Event registrations
- **Attendee** - Attendee information
- **Speaker** - Event speakers
- **EventSession** - Schedule sessions
- **Track** - Session tracks
- **Abstract** - Paper submissions
- **Hotel/RoomType/Accommodation** - Lodging management
- **AuditLog** - Action logging

## API Patterns

All API routes follow this pattern:
```typescript
export async function GET/POST/PUT/DELETE(
  req: Request,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const [session, { eventId }] = await Promise.all([auth(), params]);

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify event access
  const event = await db.event.findFirst({
    where: { id: eventId, organizationId: session.user.organizationId }
  });

  // ... handle request
}
```

## Styling

- **Primary Color:** Cerulean Blue (#00aade)
- **Gradient:** Cerulean to Light Blue
- **Accent:** Amber/Yellow
- Uses oklch color format in CSS variables
- Gradient utilities: `bg-gradient-primary`, `btn-gradient`

## Environment Variables

```env
DATABASE_URL="postgresql://..."       # Pooled connection
DIRECT_URL="postgresql://..."         # Direct connection (migrations)
NEXTAUTH_SECRET="..."                 # JWT secret
NEXTAUTH_URL="http://localhost:3000"  # App URL
NEXT_PUBLIC_APP_URL="..."             # Public app URL
BREVO_API_KEY="..."                   # Email service
EMAIL_FROM="..."                      # Sender email
EMAIL_FROM_NAME="..."                 # Sender name
LOG_LEVEL="info"                      # debug, info, warn, error
```

## Common Commands

```bash
npm run dev          # Start dev server
npm run build        # Build for production
npm run lint         # Run ESLint
npx prisma generate  # Generate Prisma client
npx prisma db push   # Push schema to database
npx prisma studio    # Open Prisma Studio
npx tsc --noEmit     # Type check
```

## Code Conventions

1. **API Routes:** Use Promise.all for parallel queries, validate with Zod
2. **Error Handling:** Use try/catch with apiLogger for errors
3. **Auth:** All dashboard routes require authentication via `auth()`
4. **Forms:** Use react-hook-form with Zod validation
5. **Toasts:** Use sonner for notifications
6. **State:** Use React hooks, avoid global state when possible

## Recent Features

- Public event registration at `/e/[slug]` (no auth required)
- User invitation system with email tokens
- Cerulean Blue theme with gradients
- Bulk email sending via Brevo
- Session calendar view
- API performance optimizations (Promise.all)
- File-based logging (`logs/app.log`, `logs/error.log`)

## Current Mode

**Single Organization Mode** (multi-org support planned for later):
- User account registration is disabled (`/register` redirects to `/login`)
- New users must be invited by an admin via Settings → Users
- Public event registration is open to all at `/e/[event-slug]`

## Logging

Logs are written to files in the `logs/` directory:
- `logs/app.log` - All logs (debug, info, warn, error)
- `logs/error.log` - Errors only

View logs: `tail -f logs/app.log`

## Documentation

- `docs/DEVELOPMENT_STATUS.md` - Feature status and roadmap
- `.env.example` - Environment variable template
