import { Fragment } from "react";
import type { RunAttribution, RunRequester } from "@/lib/run-attribution";
import { PersonName } from "./primitives";

export function RunAttributionInfo({ attribution, promptedBy = [], commitUrl }: {
  attribution?: RunAttribution | null;
  promptedBy?: RunRequester[];
  commitUrl?: string | null;
}) {
  const people = [...new Map(promptedBy.map((person) => [person.userId, person])).values()];
  return <div className="run-attribution-info">
    <p>{attribution?.kind === "system" ? "Automated feedback" : <>Prompted by {people.length ? people.map((person, index) => {
      const identity = !person.deleted ? attribution?.authors.find((author) => author.userId === person.userId) : null;
      return <Fragment key={person.userId}>{index > 0 && ", "}<PersonName name={person.name} />{identity && <> <a href={`https://github.com/${identity.login}`} target="_blank" rel="noreferrer">@{identity.login}</a></>}</Fragment>;
    }) : "Unknown"}</>}</p>
    {commitUrl && <a href={commitUrl} target="_blank" rel="noreferrer">View commit on GitHub</a>}
    {!attribution && <small>Legacy run; GitHub author credit was not recorded.</small>}
  </div>;
}
