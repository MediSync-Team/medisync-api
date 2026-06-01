import { Given, When, Then } from '@cucumber/cucumber';
import { strict as assert } from 'assert';

// === BASE DE DATOS SIMULADA (Persiste durante toda la prueba) ===
interface Turno {
  id: number;
  medico: string;
  fecha: string;
  disponible: boolean;
}

let baseDeDatosTurnos: Turno[] = [
  { id: 101, medico: 'Dr. Perez', fecha: '25 de Mayo a las 10:00 AM', disponible: true }
];

let usuarioAutenticado = '';
let respuestaDelServidor = {
  status: 0,
  mensaje: '',
  turnoReservadoId: null as number | null
};

// === PASOS DEL ESCENARIO 1 ===

Given('que el profesional {string} tiene disponibilidad el {string}', function (nombreMedico: string, fechaTurno: string) {
  console.log(`\n[MediSync DB]: Iniciando pruebas. Verificando estado inicial para el ${nombreMedico}...`);
  const turnoExistente = baseDeDatosTurnos.find(t => t.medico === nombreMedico && t.fecha === fechaTurno);
  
  assert.ok(turnoExistente, "El turno no existe en la DB ficticia.");
  console.log(`[MediSync DB]: Estado del turno ID ${turnoExistente.id}: ${turnoExistente.disponible ? 'DISPONIBLE' : 'OCUPADO'}`);
});

Given('el paciente {string} está autenticado en MediSync', function (nombrePaciente: string) {
  usuarioAutenticado = nombrePaciente;
  console.log(`[MediSync Auth]: Sesión activa detectada para: ${nombrePaciente}.`);
});

When('{string} intenta reservar el turno del {string} con el {string}', function (nombrePaciente: string, fechaTurno: string, nombreMedico: string) {
  console.log(`[MediSync API]: Solicitud POST /api/turnos/reservar recibida de [${nombrePaciente}]`);
  
  const turnoEnDb = baseDeDatosTurnos.find(t => t.medico === nombreMedico && t.fecha === fechaTurno);

  if (turnoEnDb && turnoEnDb.disponible) {
    turnoEnDb.disponible = false; // Se ocupa el turno
    respuestaDelServidor = {
      status: 201,
      mensaje: 'Reserva confirmada exitosamente',
      turnoReservadoId: turnoEnDb.id
    };
    console.log(`[MediSync API]: ¡Éxito! Turno ID ${turnoEnDb.id} asignado a ${nombrePaciente}.`);
  } else {
    respuestaDelServidor = {
      status: 400,
      mensaje: 'Turno ya no disponible',
      turnoReservadoId: null
    };
    console.log(`[MediSync API]: ¡Alerta! Solicitud rechazada. El turno solicitado por ${nombrePaciente} ya está ocupado.`);
  }
});

Then('el sistema confirma la reserva exitosamente', function () {
  assert.strictEqual(respuestaDelServidor.status, 201);
  console.log(`[MediSync Assertion]: Confirmado status 201 en la respuesta.`);
});

Then('el turno deja de estar disponible para otros pacientes', function () {
  const turnoEnDb = baseDeDatosTurnos.find(t => t.id === 101);
  assert.strictEqual(turnoEnDb?.disponible, false);
  console.log(`[MediSync Assertion]: Validado en DB que el turno 101 ahora está bloqueado.\n`);
});

// === PASOS DEL ESCENARIO 2 ===

Then('el sistema rechaza la reserva porque el turno ya no está disponible', function () {
  // Aquí validamos que el servidor haya respondido con un error de lógica de negocio (HTTP 400 Bad Request)
  assert.strictEqual(respuestaDelServidor.status, 400);
  assert.strictEqual(respuestaDelServidor.mensaje, 'Turno ya no disponible');
  console.log(`[MediSync Assertion]: OK - El sistema protegió el turno y respondió con error 400 a Carlos.\n`);
});