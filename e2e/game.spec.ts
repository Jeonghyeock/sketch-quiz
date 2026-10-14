import { expect, test, type Browser, type Page } from '@playwright/test';

// 브라우저 컨텍스트 하나 = 사용자 한 명. 컨텍스트마다 sessionStorage가 따로라 서로 다른 참가자가 된다.

async function createRoom(browser: Browser, name: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('닉네임').fill(name);
  await page.getByRole('button', { name: '방 만들기' }).click();
  await expect(page.getByRole('heading', { name: '대기실' })).toBeVisible();
  return { context, page };
}

async function joinRoom(browser: Browser, url: string, name: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  await page.getByLabel('닉네임').fill(name);
  await page.getByRole('button', { name: '입장하기' }).click();
  await expect(page.locator('.status-online')).toBeVisible();
  return { context, page };
}

async function drawLine(page: Page) {
  const box = (await page.locator('.drawing-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 15 });
  await page.mouse.up();
}

const strokes = (page: Page) => page.locator('.drawing-canvas');
const players = (page: Page) => page.getByTestId('player');

// 두 사람이 방에 모이고 alice가 첫 단어를 고른 상태까지 진행한다. 첫 차례는 먼저 들어온 alice다.
async function startTurn(browser: Browser) {
  const alice = await createRoom(browser, 'alice');
  const bob = await joinRoom(browser, alice.page.url(), 'bob');
  await expect(players(alice.page)).toHaveCount(2);
  await alice.page.getByRole('button', { name: '게임 시작' }).click();
  await expect(bob.page.getByRole('heading', { name: 'alice님이 단어를 고르고 있어요' })).toBeVisible();
  await alice.page.locator('.choice').first().click();
  const word = (await alice.page.getByTestId('word').textContent())!.trim();
  await expect(bob.page.getByTestId('hint')).toBeVisible();
  return { alice, bob, word };
}

test('그린 그림이 상대에게 보이고, 정답을 맞히면 점수를 받는다', async ({ browser }) => {
  const { alice, bob, word } = await startTurn(browser);
  expect(word.length).toBeGreaterThan(1);
  // 맞히는 사람의 화면에는 정답이 어디에도 없다.
  await expect(bob.page.getByText(word, { exact: false })).toHaveCount(0);

  await drawLine(alice.page);
  await expect(strokes(bob.page)).toHaveAttribute('data-strokes', '1');

  await bob.page.getByLabel('채팅 입력').fill('아마도오답');
  await bob.page.keyboard.press('Enter');
  await expect(alice.page.locator('.chat-line')).toContainText('아마도오답');

  await bob.page.getByLabel('채팅 입력').fill(word);
  await bob.page.keyboard.press('Enter');
  await expect(bob.page.getByRole('heading', { name: '모두 맞혔어요!' })).toBeVisible();
  await expect(alice.page.locator('.answer')).toContainText(word);
  // 정답은 채팅으로 돌지 않는다.
  await expect(alice.page.locator('.chat-line').filter({ hasText: word })).toHaveCount(0);
  await expect(players(alice.page).nth(1).getByTestId('score')).not.toHaveText('0');
});

test('그리는 도중 새로고침해도 같은 자리와 그림으로 돌아온다', async ({ browser }) => {
  const { alice, bob } = await startTurn(browser);
  await drawLine(alice.page);
  await drawLine(alice.page);
  await expect(strokes(bob.page)).toHaveAttribute('data-strokes', '2');

  await bob.page.reload();
  await expect(bob.page.locator('.status-online')).toBeVisible();
  await expect(strokes(bob.page)).toHaveAttribute('data-strokes', '2');
  await expect(players(alice.page)).toHaveCount(2); // 새 참가자로 늘어나지 않는다
  await expect(bob.page.getByTestId('hint')).toBeVisible();
});

test('그리는 사람은 실행 취소와 모두 지우기를 할 수 있고, 상대 화면에도 반영된다', async ({ browser }) => {
  const { alice, bob } = await startTurn(browser);
  await drawLine(alice.page);
  await drawLine(alice.page);
  await expect(strokes(bob.page)).toHaveAttribute('data-strokes', '2');

  await alice.page.keyboard.press('Control+z');
  await expect(strokes(bob.page)).toHaveAttribute('data-strokes', '1');
  await alice.page.getByRole('button', { name: '모두 지우기' }).click();
  await expect(strokes(bob.page)).toHaveAttribute('data-strokes', '0');
  // 맞히는 사람에게는 도구가 없다.
  await expect(bob.page.getByRole('toolbar')).toHaveCount(0);
});

test('나가기를 누르면 바로 자리가 비고, 혼자 남으면 대기실로 돌아간다', async ({ browser }) => {
  const { alice, bob } = await startTurn(browser);
  await bob.page.getByRole('button', { name: '나가기' }).click();
  await expect(bob.page.getByRole('button', { name: '방 만들기' })).toBeVisible();
  await expect(players(alice.page)).toHaveCount(1);
  await expect(alice.page.getByRole('heading', { name: '대기실' })).toBeVisible();
});
