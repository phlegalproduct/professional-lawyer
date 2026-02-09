import { useServerInfo } from "../../hooks/useServerInfo";

export const ServerInfo = () => {
  const { serverInfo } = useServerInfo();
  if (!serverInfo) {
    return null;
  }
  // Minimal display: no AI/model branding or technical details
  return (
    <div className="p-2 pt-4 self-center flex flex-col break-words text-sm text-gray-500">
      <div>Connection active</div>
    </div>
  );
};
