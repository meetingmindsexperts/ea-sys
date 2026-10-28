import { describe, expect, it } from "vitest";
import { cleanPastedHtml } from "@/lib/clean-pasted-html";

// What a browser puts on the clipboard when copying a section of a typical event website.
const WEBSITE = `<html><head><meta charset="utf-8"><style>.hero{font-family:Poppins}</style><link rel="stylesheet" href="/site.css"></head>
<body><!--StartFragment--><div class="hero" style="max-width:1200px;background:#000;color:#fff">
<h2 class="title" style="font-size:48px;font-family:Poppins">Join us in Dubai</h2>
<p style="color:#ffffff;width:640px">Register by <strong>1 March</strong> for the <em>early rate</em>.
<a href="https://example.com/register" class="btn" style="padding:20px">Register now</a></p>
<ul class="list"><li style="margin:0">Workshops</li><li>Networking</li></ul>
<table width="900" cellpadding="8" bgcolor="#eee"><tr><td style="width:450px" colspan="2">Day 1</td></tr></table>
<img src="https://example.com/a.jpg" alt="Venue" width="1200" height="800" class="hero-img">
<font face="Arial" color="red">Limited seats</font><script>track()</script></div><!--EndFragment--></body></html>`;

describe("cleanPastedHtml (owner, Oct 28, 2026)", () => {
  const { html, changed } = cleanPastedHtml(WEBSITE);

  it("drops the website's styling", () => {
    expect(changed).toBe(true);
    for (const gone of ["style=", "class=", "width=", "height=", "bgcolor", "cellpadding", "<style", "<link", "<meta", "<font", "<script", "Poppins", "track()", "StartFragment"]) {
      expect(html).not.toContain(gone);
    }
  });

  it("keeps the structure and the words", () => {
    expect(html).toContain("<h2>Join us in Dubai</h2>");
    expect(html).toContain("<strong>1 March</strong>");
    expect(html).toContain("<em>early rate</em>");
    expect(html).toContain('<a href="https://example.com/register">Register now</a>');
    expect(html).toContain("<li>Workshops</li>");
    expect(html).toContain('<td colspan="2">Day 1</td>');
    expect(html).toContain('<img src="https://example.com/a.jpg" alt="Venue">');
    expect(html).toContain("Limited seats");
  });

  it("leaves a copy from our own editor alone, so our layout blocks keep their look", () => {
    const own = '<div data-pm-slice="1 1 []"><div style="background-color: #eff6ff; padding: 20px;">Info box</div></div>';
    expect(cleanPastedHtml(own)).toEqual({ html: own, changed: false });
  });

  it("says nothing when plain copy had no styling to remove", () => {
    const plain = cleanPastedHtml("<p>Hello <b>there</b></p>");
    expect(plain.changed).toBe(false);
    expect(plain.html).toBe("<p>Hello <b>there</b></p>");
  });

  it("removes Word's conditional comments", () => {
    const word = '<!--[if gte mso 9]><xml><o:OfficeDocumentSettings/></xml><![endif]--><p class="MsoNormal">Text</p>';
    const out = cleanPastedHtml(word);
    expect(out.html).toBe("<p>Text</p>");
    expect(out.changed).toBe(true);
  });
});
