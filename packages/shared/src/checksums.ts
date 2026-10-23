const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7];

function mod97(digits: string): number {
  let rest = 0;
  for (const digit of digits) rest = (rest * 10 + Number(digit)) % 97;
  return rest;
}

/** True for a Polish bank account number (NRB): 26 digits with a correct IBAN checksum. */
export function isValidNrb(nrb: string): boolean {
  if (!/^\d{26}$/.test(nrb)) return false;
  return mod97(`${nrb.slice(2)}2521${nrb.slice(0, 2)}`) === 1;
}

/** True for a Polish tax number (NIP): 10 digits with a correct checksum. */
export function isValidNip(nip: string): boolean {
  if (!/^\d{10}$/.test(nip)) return false;
  const sum = NIP_WEIGHTS.reduce((total, weight, index) => total + weight * Number(nip[index]), 0);
  return sum % 11 === Number(nip[9]);
}
