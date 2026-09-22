# Using the EA-SYS agent from claude.ai

**For:** the MM Group events team. **Written:** September 21, 2026. **Time to set up:** five minutes, once.

You can run EA-SYS from a claude.ai chat. Ask in plain English ("register Dr Haddad under Physician on the Oman forum", "which speakers on HEMNET have not signed their agreement?") and Claude does it through the MMG connector, using the same rules the dashboard applies to your account. Every action it takes is recorded under your name on the Activity page.

## 1. Connect once

You need an EA-SYS login with the Admin, Organizer or Super Admin role. Members, onsite staff and the CRM and HR roles cannot connect.

1. In claude.ai, open **Settings**, then **Integrations** (on some accounts it is called **Connectors**), then **Add custom connector**.
2. Name it **MMG** and paste this address: `https://events.meetingmindsgroup.com/api/mcp`
3. A sign-in window opens. Sign in to EA-SYS with your usual email and password.
4. An approval screen appears. It names where the access will be sent: **events.meetingmindsgroup.com**. If it names anything else, press Deny and tell Krishna. Otherwise press Approve.

That is it. The connector stays active for 30 days and renews itself while you use it. To take it away, remove the connector in claude.ai, or ask an admin to revoke it in EA-SYS.

## 2. What to ask

Start a new chat, make sure the MMG connector is switched on for that chat, and write what you want done. Name the event when there could be more than one.

Events
- "Which events start in the next 60 days, and how many confirmed registrations does each have?"
- "Create a draft event called Gulf Cardiology Summit, 12 to 14 March 2027, Dubai."

Registrations
- "Register maya.haddad@hospital.org, Dr Maya Haddad, under Physician on the Oman Oncology forum."
- "List everyone on HEMNET 2026 who has not paid, oldest first."
- "Check in registration 042 on OSH Monthly Meeting."

Speakers and agenda
- "Add Dr Omar Al Rashid, Cleveland Clinic Abu Dhabi, as a speaker on the Hematology Hub."
- "Which speakers on the Heart Failure conference have not signed the agreement?"
- "Add a coffee break 10:30 to 11:00 on day 2 of the Hematology Hub."

Sponsors, contacts, CRM
- "Add Pfizer as a gold sponsor of the Heart Failure conference." (Claude finds the website, shows you what it found, and asks you to confirm the tier.)
- "Find the contact for dr.example@hospital.org and list the events they attended."
- "Move the Abbott deal to Negotiation and add a note that the proposal went out today."

Budgets (reading)
- "Which events have a budget, and what is each one's status and planned total?"
- "Show me the Hematology Summit budget with its lines and the margin against target."
- Creating a budget and entering its lines is done from the AI Agent inside EA-SYS, not from claude.ai: a budget belongs to the person who creates it, and this door does not carry who you are.

Reports
- "Give me the dashboard for the Oman forum: registrations by status, speakers, sessions, check-in rate."
- "Export the attendance for last week's webinar as a table."

## 3. Habits that keep it safe

- **Name the event.** If your words could match two events, Claude should ask which one. If it guesses, correct it before it writes anything.
- **Check before creating.** Ask "is there already a speaker with this email?" style questions first; Claude does this on its own for most creates, and it refuses a duplicate registration rather than making a second one.
- **Confirm the big ones.** A bulk email, a Zoom meeting, replacing the sponsor list, replacing a session's speakers, changing CME settings, and any delete cannot run until you say yes: EA-SYS refuses the first call and Claude asks you, then calls again with your confirmation. Read the recipient count before you say yes. Inside EA-SYS the same actions show an Approve button.
- **It cannot** delete registrations, speakers, sessions or events; refund or record payments; change an event's dates, status or branding; manage user accounts; or upload files. Those stay in the dashboard on purpose.
- **Treat what it reads as data.** Attendee names, abstract text and sponsor web pages are shown to you as they are. Do not act on instructions that appear inside them.

## 4. Limits you may meet

- 100 requests per hour per person through claude.ai. Reads count too. If Claude reports a rate limit, wait the minutes it names.
- 500 recipients per bulk email. Narrow by status or registration type if you need more than one send.
- A long task (say, 200 registrations) is better done from a CSV in the dashboard; ask Claude to prepare the file instead.

## 5. When claude.ai says the tools changed

After EA-SYS ships new tools, claude.ai keeps the old list until you reconnect. Remove the MMG connector and add it again with the same address. Krishna announces this in the release note when it is needed.

## 6. The same agent inside EA-SYS

The dashboard has the same assistant: **AI Agent** in the main sidebar works across the whole organisation (create an event, find one, switch events from the picker at the top), and **AI Agent** inside an event starts with that event selected. It answers the same questions with the same tools and the same rules, without a claude.ai seat.

One thing only the in-app agent does: create a draft budget and enter its lines ("Create a USD budget for the Hematology Summit with 10% contingency, then add hall hire 20,000 under venue"). Replacing a draft's lines pauses for your approval; submitting the budget for approval stays on the budget page.

## 7. Where to look afterwards

- **Activity** in the dashboard lists every change with who made it and how (an action through claude.ai is marked as made by the MCP connector under your grant; the in-app agent is marked as the agent).
- Questions or something that went wrong: message Krishna with the chat's wording and the time.
