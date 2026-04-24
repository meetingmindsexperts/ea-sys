/**
 * Default registration terms & conditions HTML.
 * Seeded on event creation and used as fallback on the public registration form.
 */
export const DEFAULT_REGISTRATION_TERMS_HTML = `
<p><strong>Important Information:</strong></p>
<p>Acceptance of the following terms and conditions constitutes a legal binding contract under UAE law.</p>
<p>Participants are required to abide by the local UAE law and local customs.</p>
<p>Please note that delegates with inappropriate attire might not be allowed access to the venue.</p>
<p>The organisers accept no responsibility for the views or opinions expressed by the speakers, chairmen, moderators or any other persons at the event.</p>
<p>The organisers will do its utmost effort to ensure the accuracy of the information presented online in regards to the program, speakers, and participants. However, it will not be liable in the unexpected event that a speaker does not attend the conference.</p>
<p>The organisers reserve the right "in extreme circumstances" to change the date/time and/or the meeting venue.</p>

<p><strong>Payment Terms:</strong></p>
<p>Payment can be made via credit card, bank transfer, or onsite. Please note that cash payments are discouraged unless no other form of payment is available.</p>
<p>Registration will only be confirmed once full payment has been received.</p>
<p>The applicable registration fees will be charged at the time of payment.</p>
<p>You will receive the payment receipt and confirmation of registration by email.</p>
<p>Carry your proof of registration and payment for a smooth check-in.</p>

<p><strong>Substitutions:</strong></p>
<p>Substitutions are permitted up to 30 days before the conference goes live. After this date cancellation fees will apply. The substitute must be from the same organization.</p>

<p><strong>Cancellation Terms:</strong></p>
<p>Cancellations received 30 days before the conference goes live will qualify for a full refund, less USD 75 refund charge.</p>

<p><strong>Refunds Policy:</strong></p>
<p>Refunds are processed on the 15th and 30th of every month. It takes 15 working days to process the refund from the date of receiving a valid, duly filled and signed refund request form.</p>
<p>Please note that we are unable to process any refund requests without the receipt of a completed and signed refund form.</p>
<p>Refunds can only be made in the same form of payment as per the original payment made and the same bank or credit card account.</p>
<p>No refund will be extended for cancellations received less than 30 days before the conference goes live.</p>

<p><strong>Data Privacy Policy:</strong></p>
<p>By registering, you consent to the collection and processing of your personal data for the purposes of event management, communication, and related services in accordance with our data privacy policy.</p>
`.trim();

/**
 * Default speaker agreement HTML — derived from the MMG Invited Faculty
 * Participation Agreement (`MMG_Invited_Speaker_Faculty_Agreement_InPerson_TEMPLATE.docx`
 * at repo root). Seeded on new event create; organizers edit per-event via
 * Event → Content → Speaker Agreement.
 *
 * Uses EA-SYS merge tokens (`{{speakerName}}` etc. resolved via
 * `mergeAgreementHtml` in `src/lib/speaker-agreement.ts`):
 *   - `{{speakerName}}` `{{jobTitle}}` `{{speakerOrganization}}`
 *     `{{speakerCountry}}` `{{speakerEmail}}`
 *   - `{{eventName}}` `{{eventDateRange}}` `{{eventVenue}}` `{{eventCity}}`
 *     `{{organizationName}}`
 *   - `{{role}}` `{{sessionTitles}}`
 *   - `{{signedDate}}`
 *
 * The same HTML is rendered to PDF (pdfkit, `generateSpeakerAgreementPdf`)
 * AND shown on the public acceptance page (`/e/[slug]/speaker-agreement?token=...`).
 * The two surfaces produce identical text byte-for-byte after token merge.
 */
export const DEFAULT_SPEAKER_AGREEMENT_HTML = `
<h1 style="text-align:center; margin-bottom:4px;">INVITED FACULTY PARTICIPATION AGREEMENT</h1>
<p style="text-align:center; color:#555; margin-top:0;"><em>In-Person Medical Events &amp; Congresses</em></p>
<p style="text-align:center;"><strong>{{eventName}}</strong><br/>{{eventDateRange}} · {{eventVenue}}, {{eventCity}}</p>
<p style="text-align:center; color:#6b7280; font-size:13px;">Template Version 2026 | Confidential — Not for Distribution</p>

<blockquote><strong>IMPORTANT</strong> — No speaker fee or honorarium is provided under this Agreement. Faculty receive pre-approved travel and accommodation support only, in accordance with applicable GCC healthcare and Mecomed compliance standards.</blockquote>

<h2>Parties &amp; Key Terms</h2>
<table>
<tbody>
<tr><td><strong>The Conference</strong></td><td>{{eventName}}, organised by {{organizationName}}</td></tr>
<tr><td><strong>Organiser</strong></td><td>{{organizationName}}</td></tr>
<tr><td><strong>Faculty Member</strong></td><td>{{speakerName}}, {{jobTitle}}, {{speakerOrganization}}, {{speakerCountry}}</td></tr>
<tr><td><strong>Faculty Role</strong></td><td>{{role}}</td></tr>
<tr><td><strong>Session(s)</strong></td><td>{{sessionTitles}}</td></tr>
<tr><td><strong>Speaker Fee</strong></td><td>No speaker fee is provided for this engagement</td></tr>
<tr><td><strong>Date of Agreement</strong></td><td>{{signedDate}}</td></tr>
</tbody>
</table>

<p>Thank you for agreeing to contribute as invited faculty at {{eventName}}. This Agreement sets out what we ask of you, what we provide in return, and the terms that govern our collaboration. Our goal is to make your participation straightforward and respectful of your time, while meeting all requirements for accredited Continuing Medical Education (CME/CPD) where applicable.</p>
<p>Please read this Agreement carefully. If you have any questions, contact the {{organizationName}} team before signing.</p>

<h2>1. Engagement</h2>
<p>1.1 The Faculty Member agrees to participate in {{eventName}} on the date(s) and at the venue specified above, and to deliver their assigned presentation, keynote, moderation, panel contribution, or facilitation as confirmed in the scientific programme.</p>
<p>1.2 Participation is voluntary. No speaker fee or honorarium is provided under this Agreement. The Faculty Member receives pre-approved travel and accommodation support only, as detailed in Section 2.</p>
<p>1.3 The Faculty Member confirms that their participation complies with all applicable laws, institutional policies, and the Mecomed Code of Practice for the Healthcare Industry in the MENA region.</p>

<h2>2. What We Provide</h2>
<p>The following support is provided in recognition of the Faculty Member's contribution. All items are subject to the terms of this Agreement and applicable GCC compliance regulations. Specific details will be confirmed in the faculty invitation letter. No speaker fee or honorarium is payable.</p>
<table>
<tbody>
<tr><th>Benefit</th><th>Details</th><th>Notes / Conditions</th></tr>
<tr><td><strong>Travel</strong></td><td>Economy or business class return air ticket or reimbursement of equivalent cost against original receipts and booking confirmations.</td><td>All travel must be pre-approved by {{organizationName}} in writing. Please do not book travel without written confirmation.</td></tr>
<tr><td><strong>Airport Transfers</strong></td><td>Return airport–hotel–venue transfers for the duration of conference duties.</td><td>Arranged directly by {{organizationName}}. Details confirmed in the faculty travel itinerary.</td></tr>
<tr><td><strong>Accommodation</strong></td><td>Hotel accommodation for the approved night(s) between check-in and check-out.</td><td>Booked and paid directly by {{organizationName}}. Additional nights at the faculty member's own expense.</td></tr>
<tr><td><strong>Conference Registration</strong></td><td>Complimentary full registration to all conference sessions and the exhibition area.</td><td>Includes access to all scientific sessions, workshops, and exhibition.</td></tr>
<tr><td><strong>Networking Events</strong></td><td>Invitation to the official faculty networking function(s) during the Conference.</td><td>Specific events to be confirmed in the final programme.</td></tr>
</tbody>
</table>

<h2>3. Presentation &amp; Materials</h2>
<p>3.1 The Faculty Member agrees to submit their presentation slides or other required materials no later than 45 days before the Conference start date. Where clinical duties prevent early submission, a structured abstract with clear objectives and key references is the minimum requirement.</p>
<p>3.2 All content must be accurate, balanced, evidence-based, and free from commercial promotion or promotional bias. The Faculty Member takes full responsibility for the scientific accuracy of their submitted content.</p>
<p>3.3 On-site: Presentation files must be submitted in PPT/PPTX format at the faculty/speaker lounge at least two hours before the session. The Faculty Member must remain available for Q&amp;A and panel discussion as scheduled in the programme.</p>
<p>3.4 Virtual/hybrid delivery: Where the Faculty Member is delivering a session remotely with {{organizationName}}'s agreement, a technical rehearsal and connectivity check are required in advance. {{organizationName}} will arrange the rehearsal slot with reasonable notice.</p>
<p>3.5 The Faculty Member confirms that their presentation does not include content that constitutes off-label promotion of any pharmaceutical product or medical device.</p>

<h2>4. Scientific Integrity &amp; Independence</h2>
<p>4.1 The Faculty Member retains full independence over their clinical opinions and professional judgement. All contributions shall be scientifically rigorous, evidence-based, and free from commercial or promotional bias.</p>
<p>4.2 {{organizationName}} commits to maintaining the scientific independence of the programme from commercial influence throughout this Conference. No sponsor, commercial entity, or third party shall influence the Faculty Member's scientific content.</p>

<h2>5. Recordings, Content Rights &amp; CME Use</h2>
<p>5.1 By signing this Agreement, the Faculty Member grants {{organizationName}} a non-exclusive, royalty-free licence to record their session (audio and/or video), and to use the recording, presentation slides, and associated materials for the following purposes: (a) CME/CPD accreditation requirements; (b) HCP-only on-demand access during the defined post-event period; (c) internal scientific archives.</p>
<p>5.2 {{organizationName}} may use the Faculty Member's name, title, professional biography, photograph, and conference-related content for scientific education and event promotion directed at healthcare professionals. Short video or audio clips may be created for distribution to HCPs via LinkedIn, WhatsApp, and email. No content will be used for commercial advertising or product promotion without the Faculty Member's prior written consent.</p>
<p>5.3 If {{organizationName}} intends to publish recording content beyond the on-demand period or on public channels, the edited version will be shared with the Faculty Member for a reasonable review period before release.</p>
<p>5.4 The Faculty Member retains all moral rights in their pre-existing intellectual property but does not retain rights to the final edited audio/video production created by {{organizationName}}.</p>
<p>5.5 CME compliance: Minor edits required for CME/CPD accreditation standards will be handled collaboratively. Any changes that would materially alter the scientific intent of the content will be discussed with the Faculty Member prior to implementation.</p>

<h2>6. Conflict of Interest Disclosure</h2>
<p>6.1 The Faculty Member must complete and return the {{organizationName}} Conflict of Interest Declaration Form prior to the Conference, disclosing all financial relationships with pharmaceutical, device, or biotechnology companies relevant to the subject matter of their engagement. This is a standard requirement for all CME/CPD-accredited scientific meetings.</p>
<p>6.2 {{organizationName}} will work with the Faculty Member to appropriately manage or disclose any conflicts of interest in accordance with applicable accreditation requirements and GCC regulatory standards.</p>

<h2>7. Compliance &amp; Ethical Standards</h2>
<p>7.1 Both parties agree to comply with: all applicable GCC healthcare and professional regulations; the Mecomed Code of Practice for the Healthcare Industry in the MENA region; international anti-bribery and anti-corruption standards (including the UAE Federal Law No. 11 of 2021 on Anti-Bribery); and applicable data protection laws.</p>
<p>7.2 The Faculty Member confirms that participation in this Conference and receipt of the travel and accommodation support described in Section 2 are compliant with all applicable laws and institutional policies, and do not violate any contractual obligations with their employer or institution.</p>
<p>7.3 The Faculty Member acknowledges that no speaker fee or honorarium is payable under this Agreement, and confirms that this arrangement is compliant with their institution's policies on external engagements.</p>

<h2>8. Confidentiality</h2>
<p>8.1 The Faculty Member agrees to maintain confidentiality in respect of any unpublished data, proprietary information, or materials shared by {{organizationName}} or fellow faculty in the course of this Conference, and not to disclose or use such information outside the scope of this Agreement.</p>
<p>8.2 This confidentiality obligation applies during and after the Conference and survives termination of this Agreement.</p>

<h2>9. Data &amp; Privacy</h2>
<p>9.1 {{organizationName}} will collect and retain the Faculty Member's personal and professional details — including name, title, affiliation, biography, contact details, photograph, Conflict of Interest disclosures, and presentation materials — for event administration, CME/CPD records, and archival purposes for up to three (3) years, in accordance with the UAE Federal Decree Law No. 45 of 2021 on the Protection of Personal Data (UAE PDPL) and applicable GCC data protection laws.</p>
<p>9.2 Personal data will not be shared with third parties without the Faculty Member's consent, except as required by applicable law or for direct programme administration (e.g. hotel, transfer provider, accreditation body).</p>

<h2>10. Cancellation, Substitution &amp; Flexible Delivery</h2>
<p>10.1 Faculty cancellation: Please notify {{organizationName}} at the earliest possible opportunity if you are unable to attend, so that a substitute can be identified and travel arrangements can be managed. Travel or accommodation costs already committed by {{organizationName}} at the time of cancellation may be recoverable depending on the notice given.</p>
<p>10.2 Conference cancellation or rescheduling: {{organizationName}} will notify the Faculty Member promptly. Any pre-agreed travel or accommodation costs already incurred by the Faculty Member and pre-approved in writing by {{organizationName}} will be reimbursed in full against original receipts.</p>
<p>10.3 Remote/hybrid delivery: If in-person attendance is not possible, the Faculty Member may, with {{organizationName}}'s prior written agreement, deliver their session remotely. Travel and accommodation benefits are not applicable for remote participation.</p>

<h2>11. Liability</h2>
<p>11.1 Each party is responsible for the accuracy of their own contributions. {{organizationName}} shall not be liable for independent clinical opinions expressed by the Faculty Member.</p>
<p>11.2 The Faculty Member releases {{organizationName}}, its organising team, and affiliates from liability for any loss, damage, or injury arising from participation in the Conference, except where caused by proven negligence on the part of {{organizationName}}.</p>
<p>11.3 {{organizationName}}'s total liability to the Faculty Member shall not exceed the direct, pre-approved costs provided under this Agreement.</p>

<h2>12. Governing Law &amp; Dispute Resolution</h2>
<p>12.1 Governing Law. This Agreement shall be governed by and construed in accordance with the laws of the United Arab Emirates.</p>
<p>12.2 Arbitration. Any dispute arising out of or in connection with this Agreement that cannot be resolved by mutual agreement shall be finally resolved by binding arbitration under the rules of the Dubai International Arbitration Centre (DIAC). The seat of arbitration shall be Dubai. The language shall be English.</p>

<h2>13. General</h2>
<p>13.1 Entire Agreement. This Agreement constitutes the entire agreement between the parties regarding the Faculty Member's participation and supersedes all prior discussions, correspondence, or arrangements.</p>
<p>13.2 Amendments. Any amendments must be agreed in writing by authorised representatives of both parties.</p>
<p>13.3 Severability. If any provision is found invalid or unenforceable, the remaining provisions shall remain in full force and effect.</p>
<p>13.4 Assignment. Neither party may assign this Agreement without the prior written consent of the other.</p>

<h2>Acceptance &amp; Checklist</h2>
<p>Please tick all that apply and sign to confirm your participation and the terms above.</p>
<ul>
<li>☐ I accept participation as invited faculty at the Conference under the terms of this Agreement.</li>
<li>☐ I accept the recording consent and CME/CPD use as set out in Section 5.</li>
<li>☐ I have completed (or will complete) the Conflict of Interest Declaration Form.</li>
<li>☐ I confirm that my participation and the travel/accommodation support provided are compliant with my institution's policies.</li>
<li>☐ I confirm that no speaker fee or honorarium is due or expected under this Agreement.</li>
</ul>
<p>By signing below, both parties confirm they have read, understood, and agreed to the terms of this Agreement.</p>
`.trim();
