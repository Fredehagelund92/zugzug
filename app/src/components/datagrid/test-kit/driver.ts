import type { UserEvent } from "@testing-library/user-event";

export function makeDriver(user: UserEvent, cellAt: (i: number, f: string) => HTMLElement) {
  const focusCell = async (i: number, field: string) => {
    await user.click(cellAt(i, field));
  };
  const press = async (keys: string) => {
    await user.keyboard(keys);
  };
  const editCell = async (i: number, field: string, value: string) => {
    await user.dblClick(cellAt(i, field));
    await user.keyboard(value);
    await user.keyboard("{Enter}");
  };
  return { focusCell, press, editCell };
}
