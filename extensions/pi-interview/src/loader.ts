import { BorderedLoader, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type LoaderResult<T> =
	| { status: "ok"; value: T }
	| { status: "cancelled" }
	| { status: "error"; error: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runWithLoader<T>(
	ctx: ExtensionContext,
	message: string,
	task: (signal?: AbortSignal) => Promise<T>,
	fallbackSignal?: AbortSignal,
): Promise<LoaderResult<T>> {
	if (ctx.mode !== "tui") {
		try {
			return { status: "ok", value: await task(fallbackSignal) };
		} catch (error) {
			if (fallbackSignal?.aborted) return { status: "cancelled" };
			return { status: "error", error: errorMessage(error) };
		}
	}

	const result = await ctx.ui.custom<LoaderResult<T>>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, message);
		const taskSignal = fallbackSignal ? AbortSignal.any([loader.signal, fallbackSignal]) : loader.signal;
		let finished = false;
		const finish = (value: LoaderResult<T>) => {
			if (finished) return;
			finished = true;
			taskSignal.removeEventListener("abort", abortTask);
			done(value);
		};
		const abortTask = () => finish({ status: "cancelled" });
		loader.onAbort = abortTask;
		taskSignal.addEventListener("abort", abortTask, { once: true });
		if (taskSignal.aborted) abortTask();
		else {
			void task(taskSignal)
				.then((value) => finish({ status: "ok", value }))
				.catch((error) => {
					if (taskSignal.aborted) finish({ status: "cancelled" });
					else finish({ status: "error", error: errorMessage(error) });
				});
		}
		return loader;
	});

	return result ?? { status: "cancelled" };
}
