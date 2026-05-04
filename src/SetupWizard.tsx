import { useEffect, useState } from "react";

type StepStatus = "pending" | "running" | "ok" | "error" | "needs-action";

type Step = {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  actionUrl?: string;
};

type Props = {
  onComplete: () => void;
};

export function SetupWizard({ onComplete }: Props) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const initial = await window.flexhaul.setup.initialSteps();
      if (!cancelled) setSteps(initial);
    })();
    const off = window.flexhaul.setup.onStep((ev) => {
      setSteps((prev) => {
        const next = [...prev];
        const i = next.findIndex((s) => s.id === ev.id);
        if (i >= 0) next[i] = ev;
        else next.push(ev);
        return next;
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const start = async () => {
    setRunning(true);
    setError(null);
    const result = await window.flexhaul.setup.run();
    setRunning(false);
    if (result.ok) {
      setDone(true);
      // Tiny pause so user sees the green check before window switches
      setTimeout(onComplete, 600);
    } else {
      setError(result.error ?? "Setup failed");
    }
  };

  return (
    <div className="setup-overlay">
      <div className="setup-card">
        <div className="prism-mark" />
        <h1>Welcome to Prism</h1>
        <p className="setup-tag">
          Prism needs a one-time setup to install its agent runtime. Takes about
          a minute.
        </p>

        <ol className="setup-steps">
          {steps.map((s) => (
            <li key={s.id} className={`setup-step setup-step-${s.status}`}>
              <span className="setup-step-icon" aria-hidden>
                {s.status === "ok"
                  ? "✓"
                  : s.status === "running"
                  ? "◐"
                  : s.status === "error"
                  ? "✗"
                  : s.status === "needs-action"
                  ? "▸"
                  : "○"}
              </span>
              <span className="setup-step-label">{s.label}</span>
              {s.detail && <span className="setup-step-detail">{s.detail}</span>}
              {s.actionUrl && s.status === "needs-action" && (
                <button
                  className="setup-step-action"
                  onClick={() => window.open(s.actionUrl, "_blank")}
                >
                  Open
                </button>
              )}
            </li>
          ))}
        </ol>

        {error && <div className="setup-error">{error}</div>}

        <div className="setup-actions">
          {!running && !done && (
            <button className="setup-primary" onClick={start}>
              Set up Prism
            </button>
          )}
          {running && <span className="setup-running">Setting up…</span>}
          {done && <span className="setup-done">Done — opening Prism</span>}
        </div>

        <p className="setup-fine">
          Requires Homebrew. If you don't have it,{" "}
          <a
            href="https://brew.sh"
            onClick={(e) => {
              e.preventDefault();
              window.open("https://brew.sh", "_blank");
            }}
          >
            install it first
          </a>
          , then re-launch Prism.
        </p>
      </div>
    </div>
  );
}
