import { expect, it } from "vite-plus/test";
import { render } from "../../test/render";
import { useThreadToolCallCount } from "./useThreadToolCallCount";

function Count({ thread, count }: { thread: string; count: number | null }) {
  return <output>{useThreadToolCallCount(thread, count) ?? "pending"}</output>;
}

it("retains the last count during a refresh only in the same thread", async () => {
  await using screen = await render(<Count thread="a" count={0} />, { router: false });
  const counter = screen.getByRole("status");
  await screen.rerender(<Count thread="a" count={null} />);
  await expect.element(counter).toHaveTextContent("0");
  await screen.rerender(<Count thread="a" count={12} />);
  await expect.element(counter).toHaveTextContent("12");
  await screen.rerender(<Count thread="a" count={null} />);
  await expect.element(counter).toHaveTextContent("12");
  await screen.rerender(<Count thread="b" count={null} />);
  await expect.element(counter).toHaveTextContent("pending");
  await screen.rerender(<Count thread="b" count={2} />);
  await expect.element(counter).toHaveTextContent("2");
});
