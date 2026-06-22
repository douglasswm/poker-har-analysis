const url = process.env.TENGAN_SOLVER_URL || "http://127.0.0.1:7333";

function fail(msg) {
  console.error(msg);
  process.exitCode = 1;
}

async function main() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(url + "/", { signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok !== false) {
      console.log(`native solver ready: ${body.backend || "unknown"} · ${url}`);
      return;
    }
    fail(`native solver not ready: ${body.error || `health ${res.status}`}${body.hint ? ` · ${body.hint}` : ""}`);
  } catch (e) {
    fail(`native solver unreachable: server not running · ${url}\nstart it with: npm run solver`);
  } finally {
    clearTimeout(timer);
  }
}

main();
