import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { initializePwaInstall, usePwaInstall } from "../lib/pwa-install";

function InstallHarness() {
  const pwa = usePwaInstall();
  return <div>{pwa.installed ? <span>Installed</span> : pwa.prompt ? <button onClick={() => void pwa.install()}>Install now</button> : <span>Unavailable</span>}</div>;
}

it("retains an early browser install prompt until the Settings UI can use it", async () => {
  const prompt = vi.fn(async () => {});
  const event = Object.assign(new Event("beforeinstallprompt"), {
    prompt,
    userChoice: Promise.resolve({ outcome: "accepted" as const })
  });
  initializePwaInstall();
  window.dispatchEvent(event);
  render(<InstallHarness />);

  await userEvent.click(screen.getByRole("button", { name: "Install now" }));
  expect(prompt).toHaveBeenCalledOnce();
  expect(await screen.findByText("Installed")).toBeInTheDocument();
});
