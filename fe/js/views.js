// View loader: fetches each view's markup fragment (fe/views/*.html) and
// injects them into #views. Runs once at startup, before any component wires
// its listeners. Fragments are plain <section> markup — no scripts — so
// injecting them is CSP-safe.

const VIEWS = ['auth', 'home', 'blocked'];

export async function loadViews() {
  const fragments = await Promise.all(
    VIEWS.map(async (name) => {
      const res = await fetch(`/views/${name}.html`);
      if (!res.ok) throw new Error(`Failed to load view "${name}" (HTTP ${res.status})`);
      return res.text();
    }),
  );
  document.getElementById('views').innerHTML = fragments.join('\n');
}
