import { BigInt, Bytes, store, Address } from "@graphprotocol/graph-ts"
import {
  AddressRegistered,
  PositionsUpdated
} from "../generated/SeventySevenV1/SeventySevenV1"
import { Position, AddressRegistration, PublicKeyPositions } from "../generated/schema"

export function handleAddressRegistered(event: AddressRegistered): void {
  const id = event.params.publicKey.toHexString()
  const ethAddress = event.params.ethAddress
  const isZeroAddress = ethAddress.equals(Address.zero())
  
  let registration = AddressRegistration.load(id)
  
  if (isZeroAddress) {
    if (registration) {
      store.remove("AddressRegistration", id)
    }
    return
  }
  
  if (!registration) {
    registration = new AddressRegistration(id)
    registration.publicKey = event.params.publicKey
  }
  
  registration.ethAddress = ethAddress
  registration.timestamp = event.block.timestamp
  registration.save()
}

export function handlePositionsUpdated(event: PositionsUpdated): void {
  const positions = event.params.positions
  const publicKey = event.params.publicKey
  const publicKeyHex = publicKey.toHexString()

  let publicKeyPositions = PublicKeyPositions.load(publicKey)

  if (publicKeyPositions) {
    const oldPositionIds = publicKeyPositions.positionIds
    for (let i = 0; i < oldPositionIds.length; i++) {
      store.remove("Position", oldPositionIds[i])
    }
    publicKeyPositions.positionIds = []
  } else {
    publicKeyPositions = new PublicKeyPositions(publicKey)
    publicKeyPositions.positionIds = []
  }

  let newPositionIds = publicKeyPositions.positionIds
  
  for (let i = 0; i < positions.length; i++) {
    const position = positions[i]
    const positionId = publicKeyHex + "-" + position.poolAddress.toHexString() + "-" + i.toString()
    
    let positionEntity = new Position(positionId)
    positionEntity.publicKey = publicKey
    positionEntity.poolAddress = position.poolAddress
    positionEntity.weight = position.weight
    positionEntity.timestamp = event.block.timestamp
    positionEntity.save()

    newPositionIds.push(positionId)
  }

  publicKeyPositions.positionIds = newPositionIds
  publicKeyPositions.save()
} 