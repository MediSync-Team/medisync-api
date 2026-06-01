# language: es
Requisito: Reserva de Turnos Médicos

  Escenario: Un paciente reserva un turno disponible exitosamente
    Dado que el profesional "Dr. Perez" tiene disponibilidad el "25 de Mayo a las 10:00 AM"
    Y el paciente "Juan" está autenticado en MediSync
    Cuando "Juan" intenta reservar el turno del "25 de Mayo a las 10:00 AM" con el "Dr. Perez"
    Entonces el sistema confirma la reserva exitosamente
    Y el turno deja de estar disponible para otros pacientes

  Escenario: Otro paciente intenta reservar el mismo turno que ya fue tomado
    Dado el paciente "Carlos" está autenticado en MediSync
    Cuando "Carlos" intenta reservar el turno del "25 de Mayo a las 10:00 AM" con el "Dr. Perez"
    Entonces el sistema rechaza la reserva porque el turno ya no está disponible