import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { getOrgContext } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/security";
import { normalizeTag } from "@/lib/utils";
import { titleEnum } from "@/lib/schemas";

const createContactSchema = z.object({
  title: titleEnum.optional(),
  email: z.string().email().max(255),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  organization: z.string().max(255).optional(),
  jobTitle: z.string().max(255).optional(),
  specialty: z.string().max(255).optional(),
  registrationType: z.string().max(255).optional(),
  bio: z.string().max(5000).optional(),
  phone: z.string().max(50).optional(),
  photo: z.string().max(500).optional().or(z.literal("")),
  city: z.string().max(255).optional(),
  country: z.string().max(255).optional(),
  associationName: z.string().max(255).optional().nullable(),
  memberId: z.string().max(100).optional().nullable(),
  studentId: z.string().max(100).optional().nullable(),
  studentIdExpiry: z.string().max(20).optional().nullable(),
  tags: z.array(z.string().max(100).transform(normalizeTag)).optional().default([]),
  notes: z.string().max(2000).optional(),
});

export async function GET(req: Request) {
  try {
    const ctx = await getOrgContext(req);

    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search") || "";
    const tagsParam = searchParams.get("tags") || "";
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50")));
    const skip = (page - 1) * limit;

    const tags = tagsParam ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean) : [];

    const where = {
      organizationId: ctx.organizationId,
      ...(search && {
        OR: [
          { firstName: { contains: search, mode: "insensitive" as const } },
          { lastName: { contains: search, mode: "insensitive" as const } },
          { email: { contains: search, mode: "insensitive" as const } },
          { organization: { contains: search, mode: "insensitive" as const } },
        ],
      }),
      ...(tags.length > 0 && {
        tags: { hasSome: tags },
      }),
    };

    const [contacts, total] = await Promise.all([
      db.contact.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          title: true,
          email: true,
          firstName: true,
          lastName: true,
          organization: true,
          jobTitle: true,
          specialty: true,
          phone: true,
          tags: true,
          createdAt: true,
        },
      }),
      db.contact.count({ where }),
    ]);

    const response = NextResponse.json({
      contacts,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
    response.headers.set("Cache-Control", "private, max-age=0, stale-while-revalidate=30");
    return response;
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error fetching contacts" });
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: "Failed to fetch contacts", detail: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const [ctx, body] = await Promise.all([getOrgContext(req), req.json()]);

    if (!ctx) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (ctx.role === "REVIEWER" || ctx.role === "SUBMITTER") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const contactLimit = checkRateLimit({
      key: `contact-create:org:${ctx.organizationId}`,
      limit: 50,
      windowMs: 60 * 60 * 1000, // 50 contacts per hour per org
    });
    if (!contactLimit.allowed) {
      return NextResponse.json(
        { error: "Contact creation limit reached. Maximum 50 per hour." },
        { status: 429, headers: { "Retry-After": String(contactLimit.retryAfterSeconds) } }
      );
    }

    const validated = createContactSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn({ msg: "Contact creation validation failed", errors: validated.error.flatten() });
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 }
      );
    }

    const { title, email, firstName, lastName, organization, jobTitle, specialty, registrationType, bio, phone, photo, city, country, tags, notes, associationName, memberId, studentId, studentIdExpiry } = validated.data;

    // Validate studentIdExpiry date format if provided
    if (studentIdExpiry && isNaN(new Date(studentIdExpiry).getTime())) {
      apiLogger.warn({ msg: "Invalid studentIdExpiry date in contact creation", email, studentIdExpiry });
      return NextResponse.json({ error: "Invalid student ID expiry date" }, { status: 400 });
    }

    const existing = await db.contact.findUnique({
      where: { organizationId_email: { organizationId: ctx.organizationId, email } },
      select: { id: true },
    });

    if (existing) {
      return NextResponse.json(
        { error: "A contact with this email already exists" },
        { status: 409 }
      );
    }

    const contact = await db.contact.create({
      data: {
        organizationId: ctx.organizationId,
        title: title || null,
        email,
        firstName,
        lastName,
        organization,
        jobTitle,
        specialty,
        registrationType,
        bio,
        phone,
        photo: photo || null,
        city,
        country,
        associationName: associationName || null,
        memberId: memberId || null,
        studentId: studentId || null,
        studentIdExpiry: studentIdExpiry ? new Date(studentIdExpiry) : null,
        tags,
        notes,
      },
    });

    return NextResponse.json(contact, { status: 201 });
  } catch (error) {
    apiLogger.error({ err: error, msg: "Error creating contact" });
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: "Failed to create contact", detail: message }, { status: 500 });
  }
}

