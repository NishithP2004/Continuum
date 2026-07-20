import { AgentPanel } from "../components/AgentPanel";
import { useSearchParams } from "react-router-dom";

export function ChatPage() {
  const [parameters] = useSearchParams();
  return <div className="chat-route"><AgentPanel contextLabel={parameters.get("context")} /></div>;
}
