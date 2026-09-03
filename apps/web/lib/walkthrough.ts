/**
 * GAP-262: 初回ウォークスルー (T-UC-35) の完了記録。
 * 登録直後に 1 回だけ出し、「完了」を押したら次回から出さない (localStorage)。
 */
export const WALKTHROUGH_DONE_KEY = 'atelier_walkthrough_done';

export function isWalkthroughDone(): boolean {
  try {
    return window.localStorage.getItem(WALKTHROUGH_DONE_KEY) === '1';
  } catch {
    return false;
  }
}

export function markWalkthroughDone(): void {
  try {
    window.localStorage.setItem(WALKTHROUGH_DONE_KEY, '1');
  } catch {
    /* localStorage が使えない環境では毎回出る (安全側) */
  }
}
