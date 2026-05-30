export const passwordPolicyMessage = "密码至少 12 位，并且必须同时包含字母和数字。";

export function validateNewPassword(password) {
  const value = typeof password === "string" ? password : "";
  const reasons = [];

  if (value.length < 12) reasons.push("min_length");
  if (value.trim() !== value) reasons.push("trimmed_whitespace");
  if (!/[A-Za-z]/.test(value)) reasons.push("letter_required");
  if (!/\d/.test(value)) reasons.push("digit_required");

  return {
    ok: reasons.length === 0,
    message: passwordPolicyMessage,
    reasons
  };
}
