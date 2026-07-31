/** Stub page for routes whose build phase has not landed yet. */
export default function Placeholder({ title, phase }) {
  return (
    <div className="page">
      <header className="page-header">
        <h1>{title}</h1>
      </header>
      <section className="card">
        <p>
          Not built yet — this page lands in <strong>phase {phase}</strong>.
        </p>
      </section>
    </div>
  );
}
