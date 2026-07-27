import { sessionTitleForId } from "@/components/home/data";
import { SessionGate } from "@/components/session/SessionGate";

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SessionGate sessionTitle={sessionTitleForId(id)} />;
}
