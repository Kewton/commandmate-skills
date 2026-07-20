import { useEffect, useState } from "react";

export function App() {
  const [id, setId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/whoami")
      .then((response) => response.json())
      .then((body) => setId(body.id ?? null))
      .catch(() => setId(null));
  }, []);

  return <main>{id ? `signed in as ${id}` : "not signed in"}</main>;
}
