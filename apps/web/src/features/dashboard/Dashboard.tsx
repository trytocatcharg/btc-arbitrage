export function Dashboard() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl">
        <p className="text-sm uppercase tracking-[0.3em] text-cyan-300">Read-only</p>
        <h1 className="mt-3 text-3xl font-semibold">BTC Arbitrage Monitor</h1>
        <p className="mt-4 max-w-2xl text-slate-300">
          This dashboard is intentionally read-only. The first slice focuses on RISEx and Extended price monitoring,
          spread detection, and Telegram alerts. Live trading controls are not implemented here.
        </p>
      </section>
      <section className="mt-6 grid gap-4 md:grid-cols-2">
        {['Latest spreads', 'Signals', 'Operations', 'Events'].map((title) => (
          <article key={title} className="rounded-xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-lg font-medium">{title}</h2>
            <p className="mt-2 text-sm text-slate-400">Waiting for the read-only bot API data source.</p>
          </article>
        ))}
      </section>
    </main>
  );
}
