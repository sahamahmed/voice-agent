import { prisma } from "../src/db.js";

const PATIENTS = [
  {
    firstName: "Maria",
    lastName: "Gonzalez",
    dateOfBirth: new Date(Date.UTC(1984, 2, 22)),
    sex: "Female",
    phoneNumber: "2135550142",
    email: "maria.gonzalez@example.com",
    addressLine1: "1120 Sunset Boulevard",
    addressLine2: "Apt 4B",
    city: "Los Angeles",
    state: "CA",
    zipCode: "90026",
    insuranceProvider: "Blue Shield of California",
    insuranceMemberId: "BSC4471902",
    preferredLanguage: "Spanish",
    emergencyContactName: "Luis Gonzalez",
    emergencyContactPhone: "2135550188",
  },
  {
    firstName: "David",
    lastName: "Okafor",
    dateOfBirth: new Date(Date.UTC(1971, 10, 3)),
    sex: "Male",
    phoneNumber: "3105550119",
    addressLine1: "88 Ocean Park Avenue",
    city: "Santa Monica",
    state: "CA",
    zipCode: "90405",
    preferredLanguage: "English",
  },
];

const seed = async () => {
  for (const patient of PATIENTS) {
    const existing = await prisma.patient.findFirst({
      where: { phoneNumber: patient.phoneNumber, deletedAt: null },
    });

    if (existing) {
      console.log(`skipped ${patient.firstName} ${patient.lastName} (already present)`);
      continue;
    }

    const created = await prisma.patient.create({ data: patient });
    console.log(`seeded  ${created.firstName} ${created.lastName} -> ${created.patientId}`);
  }
};

seed()
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
