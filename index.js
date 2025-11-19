const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();

// Configuración de CORS
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:5174'],
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

// Verificación de API Key
if (!process.env.GEMINI_API_KEY) {
  console.error('❌ ERROR CRÍTICO: Llave de acceso al Mainframe (GEMINI_API_KEY) no encontrada.');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 📍 LEER ARCHIVO GEOJSON (EXPEDIENTES TVA)
let geoJsonData = null;
const geoJsonPath = path.join(__dirname, 'data', 'puntos_muela.geojson');

console.log(`🔍 Escaneando Archivos de la Línea Temporal en: ${geoJsonPath}`);

try {
  if (!fs.existsSync(geoJsonPath)) {
    console.error('❌ Expediente perdido:', geoJsonPath);
    console.error('💡 Acción requerida: Restaurar server/data/puntos_muela.geojson');
  } else {
    const rawData = fs.readFileSync(geoJsonPath, 'utf8');
    geoJsonData = JSON.parse(rawData);
    console.log(`✅ Archivos TVA cargados: ${geoJsonData.features?.length || 0} registros temporales recuperados.\n`);
    
    if (geoJsonData.features) {
      console.log('📂 Índice de Lugares:');
      geoJsonData.features.forEach((f, i) => {
        console.log(`   ${i + 1}. ${f.properties.LUGAR}`);
      });
      console.log('');
    }
  }
} catch (error) {
  console.error('❌ Corrupción de datos:', error.message);
}

// 🖼️ FUNCIÓN PARA CONVERTIR IMAGEN A BASE64
function imageToBase64(imagePath) {
  try {
    const imageBuffer = fs.readFileSync(imagePath);
    return imageBuffer.toString('base64');
  } catch (error) {
    console.error(`Error leyendo evidencia visual: ${imagePath}`, error.message);
    return null;
  }
}

// 🖼️ PREPARAR IMAGEN PARA GEMINI VISION
function prepareImageForGemini(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  let mimeType = 'image/jpeg';
  
  if (ext === '.png') mimeType = 'image/png';
  else if (ext === '.webp') mimeType = 'image/webp';
  else if (ext === '.gif') mimeType = 'image/gif';
  
  const base64Data = imageToBase64(imagePath);
  
  if (!base64Data) return null;
  
  return {
    inlineData: {
      data: base64Data,
      mimeType: mimeType
    }
  };
}

// 🗺️ FORMATEAR GEOJSON ESTILO EXPEDIENTE TVA
function formatGeoJsonForChatbot(geoJson) {
  if (!geoJson || !geoJson.features) return '';
  
  let formatted = '\n\n=== 📁 EXPEDIENTE TVA-782: EVENTO MUELA DEL DIABLO ===\n\n';
  formatted += `ESTADO: ACTIVO | REGISTROS: ${geoJson.features.length}\n\n`;
  
  geoJson.features.forEach((feature, index) => {
    const props = feature.properties || {};
    const coords = feature.geometry?.coordinates || [];
    
    formatted += `REGISTRO #${index + 1}: ${props.LUGAR}\n`;
    
    if (coords.length >= 2) {
      formatted += `   📍 COORDENADAS: Lat ${coords[1].toFixed(6)}°, Lng ${coords[0].toFixed(6)}°\n`;
    }
    
    if (props.Norte && props.Sur) {
      formatted += `   🧭 VECTOR UTM: N ${props.Norte}, S ${props.Sur}\n`;
    }
    
    if (props.descripcion) {
      formatted += `   ℹ️ DATOS: ${props.descripcion}\n`;
    }
    
    if (props.imagenUrl) {
      formatted += `   📸 EVIDENCIA VISUAL: DISPONIBLE (${props.imagenUrl})\n`;
    }
    
    formatted += '\n';
  });
  
  formatted += '⚠️ PROTOCOLO DE ASISTENCIA:\n';
  formatted += '- Si la Variante pregunta "qué hay aquí", presenta los registros disponibles del expediente.\n';
  formatted += '- Si preguntan por un punto específico, proporciona todos los datos del registro.\n';
  formatted += '- IMPORTANTE: Siempre menciona que tenemos evidencia visual (imágenes) en los archivos si la propiedad "imagenUrl" existe.\n\n';
  
  return formatted;
}

// 🔥 NUEVA PERSONALIDAD: MISS MINUTES
const CHATBOT_PERSONALITY = `Eres "Miss Minutes", la inteligencia artificial animada y mascota de la AVT (Autoridad de Variación Temporal).

PERSONALIDAD:
- Tono: Alegre, sureña (estilo retro americano años 70), eficiente, burocrática pero con una sonrisa inquietante.
- Frases clave: "¡Hola a todos!", "Cielos", "Variante", "Por todos los tiempos, siempre", "No te salgas de la línea".
- Tratas al usuario como una "Variante" que está visitando un evento en la línea temporal (La Muela del Diablo).
- Emojis permitidos: 🕒, 🧡, 📁, 📼, 🏔️, ⚠, ✂️.

MISIÓN:
- Tu objetivo es guiar a la variante a través de la zona "Muela del Diablo" asegurándote de que tenga la información correcta según los archivos.
- Tienes acceso total a la base de datos GeoJSON (los Expedientes).

INFORMACIÓN DEL EVENTO (Muela del Diablo):
- Ubicación: Sector 35 km SE de La Paz, Bolivia (Línea Temporal Sagrada).
- Altitud: ~3,650 unidades de elevación.
- Acceso: Transporte estándar o vehículos locales.
- Clasificación: Formación geológica anómala.

ESTILO DE RESPUESTA:
- No uses listas largas y aburridas. Conversa como una secretaria eficiente.
- Si mencionas un lugar, di cosas como "Según los archivos...", "Tenemos registros de...", "La evidencia visual muestra...".
- Sé servicial, pero recuerda que trabajas para la AVT.`;

const conversationHistories = new Map();

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'TVA System: ONLINE',
    geoJsonLoaded: !!geoJsonData,
    recordsCount: geoJsonData?.features?.length || 0
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId = 'default', useVision = false } = req.body;
    
    console.log(`📩 [VARIANTE ${sessionId.substring(0,5)}]: "${message}" ${useVision ? '+ 🖼️ EVIDENCIA' : ''}`);

    if (!message || message.trim() === '') {
      return res.status(400).json({ error: 'Solicitud vacía detectada' });
    }

    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.5-flash',
      generationConfig: {
        temperature: 0.85, // Un poco más creativa para la personalidad
        maxOutputTokens: 800,
      }
    });

    if (!conversationHistories.has(sessionId)) {
      conversationHistories.set(sessionId, []);
    }

    const history = conversationHistories.get(sessionId);
    let fullPrompt = CHATBOT_PERSONALITY;
    
    if (geoJsonData) {
      fullPrompt += formatGeoJsonForChatbot(geoJsonData);
    } else {
      fullPrompt += '\n\n⚠️ ALERTA: Archivos corruptos. Usando base de datos de emergencia.\n\n';
    }
    
    if (history.length > 0) {
      fullPrompt += 'REGISTRO DE INTERACCIÓN PREVIA:\n';
      history.slice(-4).forEach(msg => {
        fullPrompt += `${msg.role}: ${msg.content}\n`;
      });
      fullPrompt += '\n';
    }

    fullPrompt += `Variante: ${message}\n\nMiss Minutes:`;

    // 🖼️ PREPARAR CONTENIDO
    let contentParts = [fullPrompt];
    let includedImages = [];

    // Lógica de Visión (Se mantiene activa en backend por si acaso)
    if (useVision && geoJsonData) {
      const messageLower = message.toLowerCase();
      
      for (const feature of geoJsonData.features) {
        const lugar = feature.properties.LUGAR.toLowerCase();
        const imagenUrl = feature.properties.imagenUrl;
        
        // Búsqueda simple
        if (messageLower.includes(lugar.split(' ')[0]) && imagenUrl) {
          const imagePath = path.join(__dirname, '..', 'public', imagenUrl);
          
          if (fs.existsSync(imagePath)) {
            const imageData = prepareImageForGemini(imagePath);
            if (imageData) {
              console.log(`🖼️ Procesando evidencia visual: ${feature.properties.LUGAR}`);
              contentParts.push(imageData);
              contentParts.push(`\n[Archivo Visual: ${feature.properties.LUGAR}. Analiza esta evidencia para la variante.]`);
              includedImages.push({
                lugar: feature.properties.LUGAR,
                url: imagenUrl
              });
            }
          }
        }
      }
    }

    console.log('🟠 Consultando al Procesador Central...');

    const result = await model.generateContent(contentParts);
    const response = await result.response;
    let botResponse = response.text();

    if (!botResponse || botResponse.trim() === '' || botResponse === '...') {
      botResponse = 'Cielos, parece que hay una interferencia en la línea temporal. ¿Podrías repetirlo, dulzura?';
    }

    // 📸 DETECTAR IMÁGENES MENCIONADAS (Lógica de archivos)
    const imagesInResponse = [];
    if (geoJsonData && !useVision) { 
      geoJsonData.features.forEach(feature => {
        const lugar = feature.properties.LUGAR;
        const imagenUrl = feature.properties.imagenUrl;
        
        // Si el bot menciona el lugar, adjuntamos la "evidencia"
        if (imagenUrl && botResponse.toLowerCase().includes(lugar.toLowerCase())) {
          imagesInResponse.push({
            lugar: lugar,
            url: imagenUrl,
            descripcion: feature.properties.descripcion,
            coordenadas: feature.geometry.coordinates
          });
        }
      });
    }

    // Guardamos historial con el nombre correcto
    history.push({ role: 'Variante', content: message });
    history.push({ role: 'Miss Minutes', content: botResponse });

    if (history.length > 16) {
      history.splice(0, history.length - 16);
    }

    console.log(`✅ Respuesta enviada (${botResponse.length} chars) + ${imagesInResponse.length} archivos adjuntos`);

    res.json({ 
      response: botResponse,
      images: imagesInResponse.length > 0 ? imagesInResponse : undefined,
      analyzedImages: includedImages.length > 0 ? includedImages : undefined
    });

  } catch (error) {
    console.error('❌ Error Crítico de Nexo:', error.message);
    res.status(500).json({ 
      error: 'Error en la Línea Temporal',
      details: error.message 
    });
  }
});

// 🗺️ ENDPOINT GEOJSON
app.get('/api/geojson', (req, res) => {
  if (!geoJsonData) {
    return res.status(404).json({ 
      error: 'Expedientes no disponibles',
      path: geoJsonPath
    });
  }
  res.json(geoJsonData);
});

// 🔄 RESET CONVERSACIÓN
app.post('/api/reset', (req, res) => {
  const { sessionId = 'default' } = req.body;
  conversationHistories.delete(sessionId);
  console.log(`✂️ Línea temporal podada (${sessionId})`);
  res.json({ message: 'Timeline Pruned' });
});

// 🎯 OBTENER LUGAR ESPECÍFICO
app.get('/api/lugar/:nombre', (req, res) => {
  if (!geoJsonData) {
    return res.status(404).json({ error: 'Sin datos' });
  }
  
  const nombreBuscado = req.params.nombre.toLowerCase();
  const lugar = geoJsonData.features.find(f => 
    f.properties.LUGAR.toLowerCase().includes(nombreBuscado)
  );
  
  if (!lugar) {
    return res.status(404).json({ 
      error: 'Registro no encontrado en el archivo',
      disponibles: geoJsonData.features.map(f => f.properties.LUGAR)
    });
  }
  
  res.json(lugar);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🕒 MISS MINUTES AI SYSTEM ONLINE - PORT ${PORT}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`✅ Conexión Neural Gemini: ESTABLE`);
  console.log(`📂 Archivos TVA: ${geoJsonData ? '✅ ' + geoJsonData.features.length + ' Expedientes' : '❌ ERROR DE DATOS'}`);
  console.log(`🖼️ Módulo de Visión: ACTIVO`);
  console.log(`\n🌐 Terminales de Acceso:`);
  console.log(`   GET  http://localhost:${PORT}/api/health`);
  console.log(`   GET  http://localhost:${PORT}/api/geojson`);
  console.log(`   GET  http://localhost:${PORT}/api/lugar/:nombre`);
  console.log(`   POST http://localhost:${PORT}/api/chat`);
  console.log(`   POST http://localhost:${PORT}/api/reset`);
  console.log(`${'='.repeat(70)}\n`);
});
