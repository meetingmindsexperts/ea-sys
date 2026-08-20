# Aggregate nginx "combined" access logs into hourly traffic buckets.
#
# Why awk and not Node: this must read /var/log/nginx/access.log, which lives on
# the HOST. The application containers mount only ./public/uploads and ./logs,
# and the log files are www-data:adm mode 640, so the container user cannot read
# them even if the directory were mounted. Installing Node on the box is against
# the container-only ops rule. awk is already there.
#
# Input:  nginx combined format, concatenated (plain or zcat'd) on stdin.
# Output: one TSV row per hour bucket on stdout. The shell wrapper turns it into
#         JSON. Splitting it this way keeps the parsing testable in isolation.
#
# Required -v arguments:
#   cutoff  the oldest hour bucket to keep, as "YYYY-MM-DDTHH".
#
# The cutoff is compared as a STRING, not an epoch. That is deliberate: the
# obvious version used gawk's mktime(), which does not exist in mawk or BSD awk,
# so the script would have run on the box (where awk is gawk) and failed
# anywhere else including any test. Zero-padded ISO sorts lexically, so string
# comparison is exactly equivalent here and costs nothing.
#
# The +0000 offset nginx writes is IGNORED rather than converted: the box runs
# UTC. Guessing at an offset conversion would be a silent correctness bug the
# day someone changes the server timezone, so non-UTC lines are COUNTED and
# reported instead, and the wrapper surfaces that count.

BEGIN {
  FS = "\"";
  split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", mn, " ");
  for (i = 1; i <= 12; i++) mon[mn[i]] = i;
  skewed = 0; parsed = 0; skipped = 0; malformed = 0;
}

{
  # Reject lines we cannot split reliably, and COUNT them, rather than
  # parsing them into plausible-looking rubbish. See the note above END.
  if (NF != 7) { malformed++; next; }

  # --- timestamp -------------------------------------------------------------
  # $1 looks like:  1.2.3.4 - - [20/Aug/2026:08:43:41 +0000]
  br = index($1, "[");
  if (br == 0) { skipped++; next; }
  ts  = substr($1, br + 1, 20);           # 20/Aug/2026:08:43:41
  off = substr($1, br + 22, 5);           # +0000

  d  = substr(ts, 1, 2);
  mo = mon[substr(ts, 4, 3)];
  y  = substr(ts, 8, 4);
  hh = substr(ts, 13, 2);
  if (mo == "" || y == "" || y !~ /^[0-9]{4}$/) { skipped++; next; }

  bucket = sprintf("%s-%02d-%sT%s", y, mo, d, hh);
  if (bucket < cutoff) { skipped++; next; }
  if (off != "+0000" && off != "") skewed++;

  # --- request ---------------------------------------------------------------
  # $2 is:  GET /path?q=1 HTTP/1.1
  split($2, req, " ");
  path = req[2];
  q = index(path, "?");
  if (q > 0) path = substr(path, 1, q - 1);

  # --- status ----------------------------------------------------------------
  # $3 is:  " 200 449 "  -> awk's " " separator strips the padding for us.
  split($3, st, " ");
  status = st[1] + 0;

  ua = tolower($6);

  # --- classification --------------------------------------------------------
  # Health checks get their own category rather than being lumped with API.
  # Route 53 polls /health roughly once a second from three addresses, which is
  # a few hundred thousand requests a day: left inside "total" it would swamp
  # every other number and make the chart useless. It is real load, so it is
  # counted, just separable.
  if (path == "/health" || path == "/worker/health" || path == "/api/health")
    cat = "health";
  else if (path ~ /^\/_next\// || path ~ /^\/uploads\// || path ~ /favicon/ ||
           path ~ /\.(css|js|mjs|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|pdf|mp4|m3u8|ts)$/)
    cat = "asset";
  else if (path ~ /^\/api\//)
    cat = "api";
  else if (path ~ /^\/e\// || path == "/" || path ~ /^\/(events|dashboard|admin|settings|login|register|crm|contacts|invoices|logs|profile|my-registration|my-reviews|verify-email)/)
    cat = "page";
  else
    cat = "other";

  # Bot detection is intentionally coarse and errs towards marking things as
  # bots. On an infra card an over-counted bot is a rounding error; a crawler
  # counted as a human is a number somebody plans around.
  isbot = 0;
  if (ua == "" || ua == "-") isbot = 1;
  else if (ua ~ /bot|crawler|spider|slurp|scrape|curl|wget|python|go-http|java\/|okhttp|axios|node-fetch|headless|phantom|puppeteer|playwright|monitoring|uptime|pingdom|statuscake|health-check|route53|newrelic|datadog|zabbix|nagios|censys|masscan|zgrab|expanse|shodan/) isbot = 1;

  parsed++;
  total[bucket]++;
  if (isbot) bots[bucket]++;

  catcount[bucket SUBSEP cat SUBSEP (isbot ? "b" : "h")]++;

  if (status >= 500)      s5[bucket]++;
  else if (status >= 400) s4[bucket]++;
  else if (status >= 300) s3[bucket]++;
  else if (status >= 200) s2[bucket]++;

  # Top-N inputs. Human page requests only: "which pages do people look at" is
  # the question, and including bots or assets makes the answer meaningless.
  if (!isbot && cat == "page") {
    safe = path;
    gsub(/[^a-zA-Z0-9._~\/-]/, "", safe);
    toppath[substr(safe, 1, 120)]++;
  }

  ref = $4;
  if (ref != "" && ref != "-" && !isbot) {
    h = ref;
    sub(/^https?:\/\//, "", h);
    sub(/\/.*$/, "", h);
    sub(/^www\./, "", h);
    gsub(/[^a-zA-Z0-9.-]/, "", h);
    if (h ~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/ &&
        h !~ /meetingmindsgroup\.com/) topref[substr(h, 1, 80)]++;
  }
}

END {
  # Section markers keep the wrapper's parsing trivial and unambiguous.
  print "#META\t" parsed "\t" skipped "\t" skewed "\t" malformed;

  split("page api asset health other", cats, " ");
  for (b in total) {
    printf "#B\t%s\t%d\t%d\t%d\t%d\t%d\t%d", b, total[b], bots[b] + 0,
      s2[b] + 0, s3[b] + 0, s4[b] + 0, s5[b] + 0;
    for (i = 1; i <= 5; i++)
      printf "\t%d\t%d", catcount[b SUBSEP cats[i] SUBSEP "h"] + 0,
                          catcount[b SUBSEP cats[i] SUBSEP "b"] + 0;
    printf "\n";
  }

  for (p in toppath) print "#P\t" toppath[p] "\t" p;
  for (r in topref)  print "#R\t" topref[r] "\t" r;
}
