// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { expect, it } from 'vitest';
import type { Receipt } from '@parity/product-lab/chain';
import { nameLinkFunding, nameLinkFundingCall, nameFundingValidator } from '../funding.ts';
it('tops up only the local PGAS shortfall under the existing asset issuer', () => {
  expect(nameLinkFundingCall(42, 'issuer', 'Ada', 3n)).toEqual({ type: 'Sudo', value: { type: 'sudo_as', value: {
    who: { type: 'Id', value: 'issuer' }, call: { type: 'Assets', value: { type: 'mint', value: { id: 42, beneficiary: { type: 'Id', value: 'Ada' }, amount: nameLinkFunding - 3n } } },
  } } });
  expect(nameLinkFundingCall(42, 'issuer', 'Ada', nameLinkFunding)).toBeUndefined();
});
it('@negative-control: refuses missing issuer and invalid balances', () => {
  expect(() => nameLinkFundingCall(42, '', 'Ada', 0n)).toThrow('Invalid');
  expect(() => nameLinkFundingCall(42, 'issuer', 'Ada', -1n)).toThrow('Invalid');
});
it('@negative-control: requires the mint inner dispatch success, not just an outer receipt', async () => {
  const receipt = (success: boolean) => ({ events: [{ type: 'Sudo', value: { type: 'SudoAsDone', value: { sudo_result: { success } } } }] }) as unknown as Receipt;
  await expect(nameFundingValidator.validate(receipt(true))).resolves.toEqual({ ok: true });
  await expect(nameFundingValidator.validate(receipt(false))).resolves.toMatchObject({ ok: false });
  await expect(nameFundingValidator.validate({ events: [] } as unknown as Receipt)).resolves.toMatchObject({ ok: false });
});
