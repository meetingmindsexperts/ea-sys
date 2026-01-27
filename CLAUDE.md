# EA-SYS (Event Administration System)

A comprehensive event management platform built with Next.js 16, designed for managing conferences, meetings, and events including registrations, speakers, sessions, accommodations, and more.

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript (strict mode)
- **Database**: PostgreSQL with Prisma ORM (v6.x)
- **Authentication**: NextAuth.js v5 (beta) with JWT strategy
- **Styling**: TailwindCSS v4 with Shadcn/ui components
- **Forms**: React Hook Form with Zod validation
- **State Management**: React Query (TanStack Query)
- **Logging**: Pino with pino-pretty (dev) / JSON (prod)
- **Deployment**: Vercel

## Project Structure

```
ea-sys/
├── prisma/
│   └── schema.prisma          # Database schema (PostgreSQL)
├── src/
│   ├── app/
│   │   ├── (auth)/            # Auth pages (login, register)
│   │   ├── (dashboard)/       # Protected dashboard pages
│   │   │   ├── dashboard/     # Main dashboard
│   │   │   └── events/
│   │   │       ├── [eventId]/ # Event-specific pages
│   │   │       │   ├── abstracts/
│   │   │       │   ├── accommodation/
│   │   │       │   ├── registrations/
│   │   │       │   ├── schedule/
│   │   │       │   │   └── calendar/
│   │   │       │   ├── settings/
│   │   │       │   ├── speakers/
│   │   │       │   └── tickets/
│   │   │       └── new/       # Create new event
│   │   ├── api/               # API routes
│   │   │   ├── auth/          # NextAuth endpoints
│   │   │   ├── events/        # Event CRUD + nested resources
│   │   │   └── organization/  # Org management
│   │   └── settings/          # Organization settings
│   ├── components/
│   │   ├── layout/            # Sidebar, Header
│   │   ├── providers.tsx      # App providers
│   │   └── ui/                # Shadcn/ui components
│   ├── constants/             # Static data (countries, etc.)
│   ├── contexts/              # React contexts
│   ├── lib/
│   │   ├── auth.ts            # NextAuth configuration
│   │   ├── auth.config.ts     # Edge-compatible auth config
│   │   ├── db.ts              # Prisma client singleton
│   │   ├── logger.ts          # Pino logging setup
│   │   └── utils.ts           # Utility functions
│   ├── middleware.ts          # Auth middleware
│   └── types/
│       └── next-auth.d.ts     # NextAuth type extensions
├── docker/                    # Docker configuration
├── docs/                      # Documentation
└── public/                    # Static assets
```

## Development Setup

### Prerequisites
- Node.js 22+ (see `.nvmrc`)
- PostgreSQL database

### Quick Start
```bash
# Install dependencies
npm install

# Generate Prisma client
npx prisma generate

# Push schema to database (development)
npx prisma db push

# Run development server
npm run dev
```

### Environment Variables
Create `.env.local` with:
```env
DATABASE_URL="postgresql://user:pass@localhost:5432/ea_sys"
DIRECT_URL="postgresql://user:pass@localhost:5432/ea_sys"  # For Vercel
NEXTAUTH_SECRET="your-random-secret"
NEXTAUTH_URL="http://localhost:3000"
LOG_LEVEL="debug"  # debug, info, warn, error
```

### Available Scripts
```bash
npm run dev       # Start development server
npm run build     # Build for production
npm run start     # Start production server
npm run lint      # Run ESLint
npm run db:push   # Push Prisma schema
npm run db:migrate # Deploy migrations
```

## Key Patterns & Conventions

### API Routes
API routes follow RESTful conventions with nested resources under events:

```typescript
// Pattern: /api/events/[eventId]/[resource]
GET    /api/events/[eventId]/registrations      # List
POST   /api/events/[eventId]/registrations      # Create
GET    /api/events/[eventId]/registrations/[id] # Get single
PUT    /api/events/[eventId]/registrations/[id] # Update
DELETE /api/events/[eventId]/registrations/[id] # Delete
```

### API Route Structure
```typescript
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";

// Zod schema for validation
const createSchema = z.object({
  field: z.string().min(1),
});

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const { eventId } = await params;
    const session = await auth();

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify event belongs to user's organization
    const event = await db.event.findFirst({
      where: {
        id: eventId,
        organizationId: session.user.organizationId,
      },
    });

    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const body = await req.json();
    const validated = createSchema.safeParse(body);

    if (!validated.success) {
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    // Create resource
    const resource = await db.resource.create({ data: validated.data });

    return NextResponse.json(resource, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error message" });
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
```

### Authentication Pattern
- Uses NextAuth.js v5 with JWT strategy
- Session includes: `id`, `email`, `name`, `role`, `organizationId`, `organizationName`, `firstName`, `lastName`
- All dashboard routes require authentication (middleware protected)
- Organization-scoped data access (multi-tenant)

```typescript
const session = await auth();
if (!session?.user) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
// Access: session.user.id, session.user.organizationId, session.user.role
```

### User Roles
- `SUPER_ADMIN` - Full system access
- `ADMIN` - Organization admin
- `ORGANIZER` - Event organizer (default)
- `REVIEWER` - Abstract reviewer

### Logging Convention
Use module-specific loggers from `@/lib/logger`:
```typescript
import { apiLogger, dbLogger, authLogger, eventLogger } from "@/lib/logger";

apiLogger.info({ msg: "Processing request", data: {} });
apiLogger.error({ err: error, msg: "Error occurred" });
```

### Date/Time Handling
Always use UTC methods for consistent server/client rendering:
```typescript
import { formatDate, formatTime, formatDateTime, formatDateLong } from "@/lib/utils";
// These use UTC methods to avoid hydration mismatches
```

### Path Aliases
Use `@/` for imports from `src/`:
```typescript
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
```

## Database Schema

### Core Entities
- **Organization** - Multi-tenant root (has users, events)
- **User** - Belongs to organization with role
- **Event** - Belongs to organization

### Event Resources
- **TicketType** - Ticket types with pricing/availability
- **Registration** - Attendee registrations
- **Attendee** - Contact info, can have multiple registrations
- **Speaker** - Event speakers with status
- **Track** - Session categories (color-coded)
- **EventSession** - Scheduled sessions
- **Abstract** - Speaker submissions
- **Hotel** - Accommodation venues
- **RoomType** - Hotel room types
- **Accommodation** - Booking records
- **AuditLog** - Activity tracking

### Key Enums
```typescript
EventStatus: DRAFT | PUBLISHED | LIVE | COMPLETED | CANCELLED
RegistrationStatus: PENDING | CONFIRMED | CANCELLED | WAITLISTED | CHECKED_IN
PaymentStatus: UNPAID | PENDING | PAID | REFUNDED | FAILED
SpeakerStatus: INVITED | CONFIRMED | DECLINED | CANCELLED
SessionStatus: DRAFT | SCHEDULED | LIVE | COMPLETED | CANCELLED
AbstractStatus: DRAFT | SUBMITTED | UNDER_REVIEW | ACCEPTED | REJECTED | REVISION_REQUESTED
```

## UI Components

### Shadcn/ui Components Available
Located in `src/components/ui/`:
- alert-dialog, avatar, badge, button, calendar
- card, checkbox, dialog, dropdown-menu, form
- input, label, popover, scroll-area, select
- separator, sheet, skeleton, sonner, switch
- table, tabs, textarea, tooltip

### Layout Components
- `Sidebar` - Collapsible navigation with localStorage persistence
- `Header` - Event selector, breadcrumbs, user menu
- `SidebarProvider` - Context for sidebar state

### Adding New Shadcn Components
```bash
npx shadcn@latest add [component-name]
```

## API Endpoints Summary

| Resource | Base Path | Operations |
|----------|-----------|------------|
| Events | `/api/events` | CRUD |
| Tickets | `/api/events/[id]/tickets` | CRUD |
| Registrations | `/api/events/[id]/registrations` | CRUD + check-in |
| Speakers | `/api/events/[id]/speakers` | CRUD |
| Tracks | `/api/events/[id]/tracks` | CRUD |
| Sessions | `/api/events/[id]/sessions` | CRUD |
| Abstracts | `/api/events/[id]/abstracts` | CRUD |
| Hotels | `/api/events/[id]/hotels` | CRUD |
| Room Types | `/api/events/[id]/hotels/[hid]/rooms` | CRUD |
| Accommodations | `/api/events/[id]/accommodations` | CRUD |
| Organization | `/api/organization` | Read/Update |

## Deployment (Vercel)

### Configuration
- Region: `iad1` (US East) - configured in `vercel.json`
- Function timeout: 30 seconds
- Build command: `prisma generate && next build`

### Required Environment Variables
```
DATABASE_URL       # Pooled connection with ?pgbouncer=true&connection_limit=1
DIRECT_URL         # Direct connection for migrations
NEXTAUTH_SECRET    # Random secret for JWT
NEXTAUTH_URL       # Production URL
```

### Performance Optimizations
- Parallel query execution with `Promise.all`
- Cache headers with `stale-while-revalidate`
- Optimized validation queries with `select: { id: true }`

## Code Conventions

1. **Validation**: Always use Zod schemas for request validation
2. **Error Handling**: Return appropriate HTTP status codes with error messages
3. **Logging**: Use structured logging with Pino, never `console.log/error`
4. **Multi-tenancy**: Always scope queries by `organizationId`
5. **Audit Logging**: Create AuditLog entries for important operations
6. **TypeScript**: Enable strict mode, avoid `any` types
7. **Imports**: Use path aliases (`@/`) for cleaner imports

## Common Tasks

### Adding a New API Resource
1. Add Prisma model to `schema.prisma`
2. Run `npx prisma db push` (dev) or create migration
3. Create route files in `src/app/api/events/[eventId]/[resource]/`
4. Add Zod schemas for validation
5. Implement CRUD handlers following existing patterns

### Adding a New Dashboard Page
1. Create page in `src/app/(dashboard)/events/[eventId]/[page]/page.tsx`
2. Add navigation item to `src/components/layout/sidebar.tsx`
3. Page is automatically protected by middleware

### Database Changes
```bash
# Development (direct push)
npx prisma db push

# Production (migrations)
npx prisma migrate dev --name description
npx prisma migrate deploy  # On deploy
```

## Future Development (Not Started)

- Payment Integration (Stripe)
- Email Notifications (SendGrid/Resend)
- Public Registration Portal
- Reporting & Analytics
- QR Code Scanner
- Badge Printing

See `docs/DEVELOPMENT_STATUS.md` for detailed roadmap.
