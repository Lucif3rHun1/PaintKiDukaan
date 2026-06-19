import { z } from "zod";

export const pinSchema = z.string().regex(/^\d{6}$/, "PIN must be exactly 6 digits");
export const recoveryPassphraseSchema = z
  .string()
  .min(12, "Recovery passphrase must be at least 12 characters")
  .max(256);
export const phoneSchema = z.string().regex(/^\+?[0-9]{10,15}$/, "Invalid phone number");
export const shopNameSchema = z.string().min(1, "Shop name is required").max(100);
export const addressSchema = z.string().min(1, "Address is required").max(500);

export const firstLaunchSchema = z
  .object({
    pin: pinSchema,
    pinConfirm: pinSchema,
    passphrase: recoveryPassphraseSchema,
    passphraseConfirm: recoveryPassphraseSchema,
    shopName: shopNameSchema,
    address: addressSchema,
    phone: phoneSchema,
  })
  .refine((d) => d.pin === d.pinConfirm, {
    path: ["pinConfirm"],
    message: "PINs do not match",
  })
  .refine((d) => d.passphrase === d.passphraseConfirm, {
    path: ["passphraseConfirm"],
    message: "Passphrases do not match",
  });

export const unlockSchema = z.object({ pin: pinSchema });

export const restoreFromRecoverySchema = z
  .object({
    passphrase: recoveryPassphraseSchema,
    newPin: pinSchema,
    newPinConfirm: pinSchema,
  })
  .refine((d) => d.newPin === d.newPinConfirm, {
    path: ["newPinConfirm"],
    message: "PINs do not match",
  });

export const changePinSchema = z
  .object({
    oldPin: pinSchema,
    newPin: pinSchema,
    newPinConfirm: pinSchema,
  })
  .refine((d) => d.newPin === d.newPinConfirm, {
    path: ["newPinConfirm"],
    message: "PINs do not match",
  });

export type FirstLaunchInput = z.infer<typeof firstLaunchSchema>;
export type UnlockInput = z.infer<typeof unlockSchema>;
export type RestoreFromRecoveryInput = z.infer<typeof restoreFromRecoverySchema>;
