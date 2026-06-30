import { z } from "zod";
import { invoke } from "../../shell/lib/ipc";

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
    gstin: z.string().optional(),
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

export const firstLaunchRestoreSchema = z.object({
  envelopePath: z.string().min(1, "Pick a backup file"),
  passphrase: recoveryPassphraseSchema,
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

export const createUserSchema = z.object({
  name: z.string().min(1, "Name is required").max(50),
  role: z.enum(["cashier", "stocker"], { required_error: "Role is required" }),
  pin: pinSchema,
  pinConfirm: pinSchema,
}).refine((d) => d.pin === d.pinConfirm, {
  path: ["pinConfirm"],
  message: "PINs do not match",
});

export type FirstLaunchInput = z.infer<typeof firstLaunchSchema>;
export type UnlockInput = z.infer<typeof unlockSchema>;
export type RestoreFromRecoveryInput = z.infer<typeof restoreFromRecoverySchema>;
export type FirstLaunchRestoreInput = z.infer<typeof firstLaunchRestoreSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const pdeSetupSchema = z
  .object({
    enabled: z.boolean(),
    decoyPin: pinSchema,
    decoyPinConfirm: pinSchema,
    duressPin: pinSchema,
    duressPinConfirm: pinSchema,
    fakeShopName: z.string().min(1, "Shop name is required").max(100),
  })
  .refine((d) => d.decoyPin === d.decoyPinConfirm, {
    path: ["decoyPinConfirm"],
    message: "Decoy PINs do not match",
  })
  .refine((d) => d.duressPin === d.duressPinConfirm, {
    path: ["duressPinConfirm"],
    message: "Duress PINs do not match",
  })
  .refine((d) => d.decoyPin !== d.duressPin, {
    path: ["duressPin"],
    message: "Duress PIN must differ from decoy PIN",
  });

export const changeDecoyPinSchema = z
  .object({
    currentRealPin: pinSchema,
    newDecoyPin: pinSchema,
    newDecoyPinConfirm: pinSchema,
  })
  .refine((d) => d.newDecoyPin === d.newDecoyPinConfirm, {
    path: ["newDecoyPinConfirm"],
    message: "PINs do not match",
  })
  .refine((d) => d.currentRealPin !== d.newDecoyPin, {
    path: ["newDecoyPin"],
    message: "Decoy PIN must differ from real PIN",
  });

export const changeDuressPinSchema = z
  .object({
    currentRealPin: pinSchema,
    newDuressPin: pinSchema,
    newDuressPinConfirm: pinSchema,
  })
  .refine((d) => d.newDuressPin === d.newDuressPinConfirm, {
    path: ["newDuressPinConfirm"],
    message: "PINs do not match",
  })
  .refine((d) => d.currentRealPin !== d.newDuressPin, {
    path: ["newDuressPin"],
    message: "Duress PIN must differ from real PIN",
  })
  .superRefine((data, ctx) => {
    if (data.newDuressPin === data.currentRealPin) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be different from your owner PIN", path: ["newDuressPin"] });
    }
  });

export const changeRecoveryPassphraseSchema = z
  .object({
    currentPin: pinSchema,
    newPassphrase: recoveryPassphraseSchema,
    newPassphraseConfirm: recoveryPassphraseSchema,
  })
  .refine((d) => d.newPassphrase === d.newPassphraseConfirm, {
    path: ["newPassphraseConfirm"],
    message: "Passphrases do not match",
  });

export type PdeSetupInput = z.infer<typeof pdeSetupSchema>;

// IPC wrappers for owner-only PIN + passphrase management
export async function changePin(payload: { oldPin: string; newPin: string }): Promise<void> {
  return invoke<void>("change_pin", {
    old_pin: payload.oldPin,
    new_pin: payload.newPin,
  });
}

export async function setRecoveryPassphrase(payload: {
  currentPin: string;
  newPassphrase: string;
}): Promise<void> {
  return invoke<void>("set_recovery_passphrase", {
    current_pin: payload.currentPin,
    new_passphrase: payload.newPassphrase,
  });
}
export type ChangeDecoyPinInput = z.infer<typeof changeDecoyPinSchema>;
export type ChangeDuressPinInput = z.infer<typeof changeDuressPinSchema>;
export type ChangePinInput = z.infer<typeof changePinSchema>;
export type ChangeRecoveryPassphraseInput = z.infer<
  typeof changeRecoveryPassphraseSchema
>;
